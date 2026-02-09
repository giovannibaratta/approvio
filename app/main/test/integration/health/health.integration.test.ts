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

describe("Health API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let redisPrefix: string

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
    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await cleanRedisByPrefix(redisPrefix)
    await app.close()
  })

  it("should return 200 OK with status OK when dependencies are healthy", async () => {
    const response = await get(app, "/health").build()

    expect(response).toHaveStatusCode(HttpStatus.OK)
    const body: HealthResponse = response.body
    expect(body.status).toEqual("OK")
  })
})

describe("Health API - Bad Cases", () => {
  let app: NestApplication

  beforeEach(async () => {
    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(
          MockConfigProvider.fromOriginalProvider({
            dbConnectionUrl: "postgresql://invalid:invalid@localhost:5432/nonexistent"
          })
        )
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication()
    await app.init()
  }, 30000)

  afterEach(async () => {
    await app.close()
  })

  it("should return 503 Service Unavailable when database connection fails", async () => {
    const response = await get(app, "/health").build()

    expect(response).toHaveStatusCode(HttpStatus.SERVICE_UNAVAILABLE)
    const body: HealthResponse = response.body
    expect(body.status).toEqual("DEPENDENCY_ERROR")
    expect(body.message).toBeDefined()
  })
})
