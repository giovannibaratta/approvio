import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {Test, TestingModule} from "@nestjs/testing"
import {cleanDatabase, cleanRedisByPrefix, prepareDatabase, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {get} from "@test/requests"
import {PrismaClient} from "@prisma/client"
import {DatabaseClient} from "@external"
import {failTaskEither} from "@test/injectors"
import {HealthService} from "@services/health"

describe("Ping API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let redisPrefix: string

  beforeAll(async () => {
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

    app = module.createNestApplication({logger: false})
    prisma = module.get(DatabaseClient).prisma
    await app.init()
  }, 30000)

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await cleanDatabase(prisma)
    await cleanRedisByPrefix(redisPrefix)
  })

  it("should return 200 OK with status OK", async () => {
    const response = await get(app, "/ping").build()

    expect(response).toHaveStatusCode(HttpStatus.OK)
    expect(response.body).toEqual({status: "OK"})
  })

  it("should return 200 OK even when health check dependencies fail", async () => {
    const healthService = app.get(HealthService)
    failTaskEither(healthService, "checkHealth", "db_health_check_failed")

    const response = await get(app, "/ping").build()

    expect(response).toHaveStatusCode(HttpStatus.OK)
    expect(response.body).toEqual({status: "OK"})
  })

  it("should not apply rate limiting headers to /ping", async () => {
    const response = await get(app, "/ping").build()

    expect(response).toHaveStatusCode(HttpStatus.OK)
    expect(response.headers).not.toHaveProperty("ratelimit")
    expect(response.headers).not.toHaveProperty("ratelimit-policy")
  })
})
