import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {pipe} from "fp-ts/function"
import {DriverAdapterError} from "@prisma/driver-adapter-utils"
import {
  DATABASE_RUNTIME_ROLE_TOKEN,
  DatabaseClient,
  ConflictingIsolationLevelError,
  TenantContextRequiredError
} from "@external/database/database-client"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {GroupTenantClient, UserTenantClient} from "@external/database/tenant-database-clients"
import {createFixturePrismaClient, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {seedTwoOrganizationFixture, TwoOrganizationFixture} from "@test/tenancy"
import {transactionContext} from "@external/database/transaction-context"
import {UserDbRepository} from "@external/database/user.repository"
import {createMockUserDomain} from "@test/mock-data"
import "@utils/matchers"
import {fromPromise} from "@external/database/repository-operation"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {Prisma, PrismaClient} from "@prisma/client"
import {v7 as uuidv7} from "uuid"

describe("PrismaTransactionManager Integration", () => {
  let isolatedDb: string
  let module: TestingModule
  let dbClient: DatabaseClient
  let prisma: PrismaClient
  let transactionManager: PrismaTransactionManager
  let repository: UserDbRepository
  let fixture: TwoOrganizationFixture

  beforeEach(async () => {
    isolatedDb = await prepareDatabase()
    try {
      const config: Pick<ConfigProvider, "databaseConfig"> = {
        databaseConfig: {
          tenantConnectionUrl: isolatedDb,
          platformConnectionUrl: isolatedDb,
          poolSize: 2,
          retry: {maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
        }
      }
      module = await Test.createTestingModule({
        providers: [
          DatabaseClient,
          GroupTenantClient,
          UserTenantClient,
          UserDbRepository,
          PrismaTransactionManager,
          {provide: ConfigProvider, useValue: config},
          {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_tenant_runtime"}
        ]
      }).compile()
      dbClient = module.get(DatabaseClient)
      prisma = createFixturePrismaClient(isolatedDb)
      transactionManager = module.get(PrismaTransactionManager)
      repository = module.get(UserDbRepository)
      await module.init()
    } catch (e) {
      console.error("Error while initializing test", e)
      throw e
    }
    fixture = await seedTwoOrganizationFixture(prisma)
  }, 30000)

  afterEach(async () => {
    await module.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(isolatedDb)
  }, 30000)

  async function createUserFixture() {
    const user = createMockUserDomain({organizationId: fixture.organizationA.id})
    await prisma.platformAccount.create({
      data: {
        id: user.accountId,
        displayName: user.displayName,
        profileEmail: `${user.accountId}@example.com`,
        status: "active",
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        occ: 0n
      }
    })
    return user
  }

  it("should rollback transaction when computation returns Left", async () => {
    // Given
    const user1 = await createUserFixture()
    const user2 = await createUserFixture()

    let attempts = 0

    const computation = () => {
      attempts++
      return pipe(
        repository.createUser(user1),
        TE.chainW(() => repository.createUser(user2)),
        TE.chainW(() => TE.left("explicit_rollback" as const))
      )
    }

    // When
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, computation)()

    // Expect
    expect(result).toBeLeftOf("explicit_rollback")
    expect(attempts).toBe(1)
    // Rollback must clear the ambient context so later operations cannot reuse the closed transaction.
    expect(() => module.get(UserTenantClient).cx).toThrow(TenantContextRequiredError)

    // Verify no users were created
    const dbUser1 = await prisma.user.findUnique({where: {id: user1.id}})
    const dbUser2 = await prisma.user.findUnique({where: {id: user2.id}})
    expect(dbUser1).toBeNull()
    expect(dbUser2).toBeNull()
  })

  it("should rollback transaction when computation throws an error", async () => {
    // Given
    const user = await createUserFixture()

    const computation = () =>
      pipe(
        repository.createUser(user),
        TE.map(() => {
          throw new Error("Unexpected crash")
        })
      )

    // When
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, computation)()

    // Expect
    expect(result).toBeLeftOf("storage_unavailable")

    // Verify user was not created
    const dbUser = await prisma.user.findUnique({where: {id: user.id}})
    expect(dbUser).toBeNull()
  })

  it("should persist data when computation returns Right", async () => {
    // Given
    const user1 = await createUserFixture()
    const user2 = await createUserFixture()

    const computation = () =>
      pipe(
        repository.createUser(user1),
        TE.chain(() => repository.createUser(user2))
      )

    // When
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, computation)()

    // Expect
    expect(result).toBeRight()

    // Verify users were created
    const dbUser1 = await prisma.user.findUnique({where: {id: user1.id}})
    const dbUser2 = await prisma.user.findUnique({where: {id: user2.id}})
    expect(dbUser1).not.toBeNull()
    expect(dbUser2).not.toBeNull()
  })

  it("should reuse the ambient transaction for nested dbClient.transactional() calls", async () => {
    // Given
    const user1 = await createUserFixture()
    const user2 = await createUserFixture()

    const computation = () =>
      pipe(
        // The repository uses the ambient tenant transaction.
        repository.createUser(user1),
        TE.chainW(() =>
          TE.tryCatch(
            // user2 created via a direct nested transactional() — must reuse the outer tx
            () =>
              dbClient.transactional({type: "organization", organizationId: fixture.organizationA.id}, async tx => {
                await tx.user.create({
                  data: {
                    id: user2.id,
                    displayName: user2.displayName,
                    organizationId: user2.organizationId,
                    platformAccountId: user2.accountId,
                    status: user2.status,
                    orgRole: user2.orgRole,
                    roles: [],
                    createdAt: user2.createdAt,
                    updatedAt: user2.updatedAt,
                    occ: 0n
                  }
                })
              }),
            () => "unknown_error" as const
          )
        ),
        TE.chainW(() => TE.left("explicit_rollback" as const))
      )

    // When
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, computation)()

    // Expect
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
            {type: "organization", organizationId: fixture.organizationA.id},
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
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, computation, {
      isolationLevel: "RepeatableRead"
    })()

    expect(result).toBeLeftOf("conflicting_isolation_level")
  })

  describe("DatabaseClient Transaction Retries", () => {
    it("should retry transactional database operations on transient errors and eventually succeed", async () => {
      // Given: a transient write conflict error (P2034).
      const transientError = new Prisma.PrismaClientKnownRequestError("Transaction failed", {
        code: "P2034",
        clientVersion: "7.9.1"
      })
      let attempts = 0

      // When
      const result = await dbClient.transactional(
        {type: "organization", organizationId: fixture.organizationA.id},
        () => {
          attempts++
          if (attempts < 3) return Promise.reject(transientError)
          return Promise.resolve("success")
        }
      )

      // Expect
      expect(result).toBe("success")
      expect(attempts).toBe(3)
    })

    it("should NOT retry transactional database operations on non-transient errors", async () => {
      // Given: a non-transient unique constraint error (P2002).
      const nonTransientError = new Prisma.PrismaClientKnownRequestError("Unique constraint violation", {
        code: "P2002",
        clientVersion: "7.9.1"
      })
      let attempts = 0

      // When / Expect
      await expect(
        dbClient.transactional({type: "organization", organizationId: fixture.organizationA.id}, () => {
          attempts++
          return Promise.reject(nonTransientError)
        })
      ).rejects.toThrow(nonTransientError)
      expect(attempts).toBe(1)
    })
  })

  it("isolates concurrent organizations and clears context after commit", async () => {
    const [groupsA, groupsB] = await Promise.all([
      dbClient.transactional({type: "organization", organizationId: fixture.organizationA.id}, tx =>
        tx.group.findMany()
      ),
      dbClient.transactional({type: "organization", organizationId: fixture.organizationB.id}, tx =>
        tx.group.findMany()
      )
    ])

    expect(groupsA).toHaveLength(1)
    expect(groupsB).toHaveLength(1)
    expect(groupsA[0]?.organizationId).toBe(fixture.organizationA.id)
    expect(groupsB[0]?.organizationId).toBe(fixture.organizationB.id)
    expect(() => module.get(GroupTenantClient).cx).toThrow(TenantContextRequiredError)
  })

  it("returns semantic OCC conflicts without retrying and restores context", async () => {
    let attempts = 0
    const observedOrganizations: string[] = []
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, () => async () => {
      attempts++
      const [setting] = await dbClient.transactional(
        {type: "organization", organizationId: fixture.organizationA.id},
        tx =>
          tx.$queryRaw<Array<{organizationId: string}>>`
          SELECT current_setting('approvio.organization_id') AS "organizationId"
        `
      )
      if (setting) observedOrganizations.push(setting.organizationId)
      return E.left("concurrency_error" as const)
    })()

    expect(result).toBeLeftOf("concurrency_error")
    expect(attempts).toBe(1)
    expect(observedOrganizations).toEqual([fixture.organizationA.id])
  })

  it("returns retry_exhausted after confirmed serialization retries", async () => {
    let attempts = 0
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, () => () => {
      attempts++
      return Promise.reject(
        new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict", {
          code: "P2034",
          clientVersion: "7.9.1"
        })
      )
    })()

    expect(result).toBeLeftOf("retry_exhausted")
    expect(attempts).toBe(3)
  })

  it("retries repository Lefts with a retained serialization cause and rolls back prior writes", async () => {
    // Given
    const groupId = uuidv7()
    const context = {organizationId: fixture.organizationA.id}
    let attempts = 0

    // When
    const result = await transactionManager.execute(context, () =>
      pipe(
        fromPromise(
          async () => {
            attempts++
            await module.get(GroupTenantClient).cx.group.create({
              data: {
                id: groupId,
                organizationId: context.organizationId,
                name: `retry-${groupId}`,
                description: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                occ: 0n
              }
            })
            if (attempts < 3)
              return Promise.reject(
                new Prisma.PrismaClientKnownRequestError("write conflict", {
                  code: "P2034",
                  clientVersion: "7.9.1"
                })
              )
          },
          () => "repository_dependency_error" as const
        )
      )
    )()
    const rows = await prisma.group.findMany({where: {id: groupId}})

    // Expect
    expect(result).toBeRightOf(undefined)
    expect(attempts).toBe(3)
    expect(rows).toHaveLength(1)
  })

  it("rolls back a direct transaction callback returning Left", async () => {
    // Given
    const groupId = uuidv7()
    const context = {organizationId: fixture.organizationA.id}

    // When
    const result = await dbClient.transactional(
      {type: "organization", organizationId: context.organizationId},
      async tx => {
        await tx.group.create({
          data: {
            id: groupId,
            organizationId: context.organizationId,
            name: `left-${groupId}`,
            description: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            occ: 0n
          }
        })
        return E.left("business_rejected" as const)
      }
    )
    const persisted = await prisma.group.findUnique({where: {id: groupId}})

    // Expect
    expect(result).toBeLeftOf("business_rejected")
    expect(persisted).toBeNull()
  })

  it("retries direct adapter serialization failures and reports exhaustion", async () => {
    let attempts = 0
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, () => () => {
      attempts++
      return Promise.reject(
        new DriverAdapterError({
          kind: "TransactionWriteConflict",
          originalCode: "40001",
          originalMessage: "could not serialize access"
        })
      )
    })()

    expect(result).toBeLeftOf("retry_exhausted")
    expect(attempts).toBe(3)
  })

  it.each([
    "Transaction API error",
    "Transaction already closed: A commit cannot be executed on an expired transaction.",
    "Transaction already closed: A commit cannot be executed on a transaction that was rolled back."
  ])("returns storage_unavailable without retrying P2028: %s", async message => {
    let attempts = 0
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, () =>
      TE.tryCatch(
        () => {
          attempts++
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError(message, {
              code: "P2028",
              clientVersion: "7.9.1"
            })
          )
        },
        error => {
          throw error
        }
      )
    )()

    expect(result).toBeLeftOf("storage_unavailable")
    expect(attempts).toBe(1)
  })

  it("shares a same-organization nested transaction", async () => {
    let outerClient: Prisma.TransactionClient | undefined
    let innerClient: Prisma.TransactionClient | undefined

    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, () => {
      outerClient = transactionContext.getStore()?.tx
      return transactionManager.execute({organizationId: fixture.organizationA.id}, () => {
        innerClient = transactionContext.getStore()?.tx
        return TE.right("nested")
      })
    })()

    expect(result).toBeRightOf("nested")
    expect(outerClient).toBeDefined()
    expect(innerClient).toBe(outerClient)
  })

  it("rejects nested cross-organization requests", async () => {
    const crossOrganization = await transactionManager.execute({organizationId: fixture.organizationA.id}, () =>
      transactionManager.execute({organizationId: fixture.organizationB.id}, () => TE.right(undefined))
    )()
    expect(crossOrganization).toBeLeftOf("organization_mismatch")
  })
})
