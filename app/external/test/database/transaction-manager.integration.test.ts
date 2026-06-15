import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {DatabaseClient, UserDbRepository, KmsModule, ConfigModule} from "@external"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {ConflictingIsolationLevelError} from "@external/database/database-client"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {createMockUserDomain} from "@test/mock-data"
import {MockConfigProvider} from "@test/mock-data"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import "expect-more-jest"
import type {PrismaClient} from "@prisma/client"
import {Prisma} from "@prisma/client"

describe("PrismaTransactionManager Integration", () => {
  let prisma: PrismaClient
  let dbClient: DatabaseClient
  let repository: UserDbRepository
  let transactionManager: PrismaTransactionManager

  beforeEach(async () => {
    try {
      const isolatedDb = await prepareDatabase()

      const module: TestingModule = await Test.createTestingModule({
        imports: [ConfigModule, KmsModule],
        providers: [DatabaseClient, UserDbRepository, PrismaTransactionManager]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
        .compile()

      module.createNestApplication({logger: false})

      dbClient = module.get(DatabaseClient)
      prisma = dbClient.prisma
      repository = module.get(UserDbRepository)
      transactionManager = module.get(PrismaTransactionManager)

      await dbClient.onModuleInit()
    } catch (e) {
      console.error("Error while initializing test", e)
      throw e
    }
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await dbClient.onModuleDestroy()
  })

  it("should rollback transaction when computation returns Left", async () => {
    // Given
    const user1 = createMockUserDomain()
    const user2 = createMockUserDomain()

    const computation = () =>
      pipe(
        repository.createUser(user1),
        TE.chainW(() => repository.createUser(user2)),
        TE.chainW(() => TE.left("explicit_rollback" as const))
      )

    // When
    const result = await transactionManager.execute(computation)()

    // Then
    expect(result).toBeLeftOf("explicit_rollback")

    // Verify no users were created
    const dbUser1 = await prisma.user.findUnique({where: {id: user1.id}})
    const dbUser2 = await prisma.user.findUnique({where: {id: user2.id}})
    expect(dbUser1).toBeNull()
    expect(dbUser2).toBeNull()
  })

  it("should rollback transaction when computation throws an error", async () => {
    // Given
    const user = createMockUserDomain()

    const computation = () =>
      pipe(
        repository.createUser(user),
        TE.map(() => {
          throw new Error("Unexpected crash")
        }),
        TE.mapLeft(e => e as string)
      )

    // When
    const result = await transactionManager.execute(computation)()

    // Then
    expect(result).toBeLeftOf("unknown_error")

    // Verify user was not created
    const dbUser = await prisma.user.findUnique({where: {id: user.id}})
    expect(dbUser).toBeNull()
  })

  it("should persist data when computation returns Right", async () => {
    // Given
    const user1 = createMockUserDomain()
    const user2 = createMockUserDomain()

    const computation = () =>
      pipe(
        repository.createUser(user1),
        TE.chain(() => repository.createUser(user2))
      )

    // When
    const result = await transactionManager.execute(computation)()

    // Then
    expect(result).toBeRight()

    // Verify users were created
    const dbUser1 = await prisma.user.findUnique({where: {id: user1.id}})
    const dbUser2 = await prisma.user.findUnique({where: {id: user2.id}})
    expect(dbUser1).not.toBeNull()
    expect(dbUser2).not.toBeNull()
  })

  it("should reuse the ambient transaction for nested dbClient.transactional() calls", async () => {
    // Given
    const user1 = createMockUserDomain()
    const user2 = createMockUserDomain()

    const computation = () =>
      pipe(
        // user1 created via repository — uses this.dbClient.cx (ambient tx)
        repository.createUser(user1),
        TE.chainW(() =>
          TE.tryCatch(
            // user2 created via a direct nested transactional() — must reuse the outer tx
            () =>
              dbClient.transactional(async tx => {
                await tx.user.create({
                  data: {
                    id: user2.id,
                    displayName: user2.displayName,
                    email: user2.email,
                    createdAt: user2.createdAt,
                    occ: 0
                  }
                })
              }),
            () => "unknown_error" as const
          )
        ),
        TE.chainW(() => TE.left("explicit_rollback" as const))
      )

    // When
    const result = await transactionManager.execute(computation)()

    // Then
    expect(result).toBeLeftOf("explicit_rollback")

    // Both users must be rolled back atomically
    const dbUser1 = await prisma.user.findUnique({where: {id: user1.id}})
    const dbUser2 = await prisma.user.findUnique({where: {id: user2.id}})
    expect(dbUser1).toBeNull()
    expect(dbUser2).toBeNull()
  })

  // a nested call requesting a strictly stronger isolation level must surface as conflicting_isolation_level.
  // The computation re-throws ConflictingIsolationLevelError so execute()'s outer handler can catch it.
  it("should return conflicting_isolation_level when inner call requests a stronger isolation level", async () => {
    const computation = () =>
      TE.tryCatch(
        () =>
          dbClient.transactional(
            async () => {
              /* no-op — conflict is detected before entering the callback */
            },
            {isolationLevel: Prisma.TransactionIsolationLevel.Serializable}
          ),
        error => {
          // Re-throw so PrismaTransactionManager.execute() can map it to "conflicting_isolation_level"
          if (error instanceof ConflictingIsolationLevelError) throw error
          return "unknown_error" as const
        }
      )

    // outer execute started at RepeatableRead (3), inner requests Serializable (4) → conflict
    const result = await transactionManager.execute(computation, {isolationLevel: "RepeatableRead"})()

    expect(result).toBeLeftOf("conflicting_isolation_level")
  })

  describe("DatabaseClient Transaction Retries", () => {
    it("should retry transactional database operations on transient errors and eventually succeed", async () => {
      // Given: A transient write conflict error (P2034)
      const transientError = new Prisma.PrismaClientKnownRequestError("Transaction failed", {
        code: "P2034",
        clientVersion: "7.8.0"
      })

      // Spy on Prisma $transaction. First two times it throws transientError, third time it succeeds.
      let attempts = 0
      const transactionSpy = jest
        .spyOn(prisma, "$transaction")
        .mockImplementation((computation: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          attempts++
          if (attempts < 3) throw transientError
          // On 3rd attempt, run the actual computation
          return computation(prisma)
        })

      // When
      const result = await dbClient.transactional(() => {
        return Promise.resolve("success")
      })

      // Then
      expect(result).toBe("success")
      expect(attempts).toBe(3)

      transactionSpy.mockRestore()
    })

    it("should NOT retry transactional database operations on non-transient errors", async () => {
      // Given: A non-transient unique constraint error (P2002)
      const nonTransientError = new Prisma.PrismaClientKnownRequestError("Unique constraint violation", {
        code: "P2002",
        clientVersion: "7.8.0"
      })

      const transactionSpy = jest.spyOn(prisma, "$transaction").mockRejectedValue(nonTransientError)

      // When & Then
      await expect(
        dbClient.transactional(() => {
          return Promise.resolve("success")
        })
      ).rejects.toThrow(nonTransientError)

      // Assert only 1 call is made (no retries)
      expect(transactionSpy).toHaveBeenCalledTimes(1)

      transactionSpy.mockRestore()
    })
  })
})
