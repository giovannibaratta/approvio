import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {DatabaseClient, UserDbRepository, KmsModule, ConfigModule} from "@external"
import type {PrismaClient} from "@prisma/client"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {createMockUserDomain} from "@test/mock-data"
import {MockConfigProvider} from "@test/mock-data"
import "expect-more-jest"
import {unwrapRight} from "@utils/either"

describe("UserDbRepository Integration", () => {
  let prisma: PrismaClient
  let repository: UserDbRepository

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule, KmsModule],
      providers: [UserDbRepository, DatabaseClient]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
      .compile()

    const dbClient = module.get(DatabaseClient)
    prisma = dbClient.prisma
    repository = module.get(UserDbRepository)

    await dbClient.onModuleInit()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
  })

  describe("createUser", () => {
    it("should create a user successfully", async () => {
      // Given
      const user = createMockUserDomain()

      // When
      const eitherResult = await repository.createUser(user)()

      // Expect
      expect(eitherResult).toBeRight()
      const result = unwrapRight(eitherResult)
      const dbUser = await prisma.user.findUnique({where: {id: result.id}})
      expect(dbUser).toBeDefined()
    })

    it("should return user_already_exists when creating a user with a duplicate id", async () => {
      // Given
      const existingUser = createMockUserDomain()
      const eitherResultFirst = await repository.createUser(existingUser)()
      expect(eitherResultFirst).toBeRight()

      // When
      const eitherResultSecond = await repository.createUser(existingUser)()

      // Expect
      expect(eitherResultSecond).toBeLeftOf("user_already_exists")
    })

    it("should return user_already_exists when creating a user with a duplicate email", async () => {
      // Given
      const existingUser = createMockUserDomain()
      const eitherResultFirst = await repository.createUser(existingUser)()
      expect(eitherResultFirst).toBeRight()
      const duplicatedUser = createMockUserDomain({email: existingUser.email})

      // When
      const eitherResultSecond = await repository.createUser(duplicatedUser)()

      // Expect
      expect(eitherResultSecond).toBeLeftOf("user_already_exists")
    })
  })
})
