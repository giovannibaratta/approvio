import {AppModule} from "@app/app.module"
import {HealthResponse} from "@approvio/api"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {Test, TestingModule} from "@nestjs/testing"
import {cleanDatabase, cleanRedisByPrefix, prepareDatabase, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {get} from "@test/requests"
import {PrismaClient} from "@prisma/client"
import {DatabaseClient} from "@external"
import {HEALTH_REPOSITORY_TOKEN, HealthRepository} from "@services/health"
import * as TE from "fp-ts/TaskEither"

describe("Health API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let redisPrefix: string
  let healthRepository: HealthRepository

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb, redisPrefix))
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication()
    prisma = module.get(DatabaseClient)
    healthRepository = module.get(HEALTH_REPOSITORY_TOKEN)
    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await cleanRedisByPrefix(redisPrefix)
    await app.close()
  })

  describe("Good cases", () => {
    it("should return 200 OK with status OK when dependencies are healthy", async () => {
      const response = await get(app, "/health").build()

      expect(response).toHaveStatusCode(HttpStatus.OK)
      const body: HealthResponse = response.body
      expect(body.status).toEqual("OK")
    })
  })

  it("should return 503 Service Unavailable when database connection fails", async () => {
    // Given: an initially healthy app
    let response = await get(app, "/health").build()
    expect(response).toHaveStatusCode(HttpStatus.OK)

    // When: the database connection fails
    jest.spyOn(healthRepository, "checkDatabaseConnection").mockReturnValue(TE.left("db_health_check_failed"))
    response = await get(app, "/health").build()

    // Expect: 503 Service Unavailable with status DEPENDENCY_ERROR and a message
    expect(response).toHaveStatusCode(HttpStatus.SERVICE_UNAVAILABLE)
    const body: HealthResponse = response.body
    expect(body.status).toEqual("DEPENDENCY_ERROR")
    expect(body.message).toEqual("DB_HEALTH_CHECK_FAILED")
  })
})
