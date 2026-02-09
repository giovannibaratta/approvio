import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {Test, TestingModule} from "@nestjs/testing"
import {cleanDatabase, cleanRedisByPrefix, prepareDatabase, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {get} from "@test/requests"
import {DatabaseClient} from "@external"
import {CustomLogger} from "../../../src/logging/custom-logger"
import {RequestContext} from "../../../src/logging/request-context"
import {HealthService} from "@services/health"
import * as TE from "fp-ts/TaskEither"
import {PrismaClient} from "@prisma/client"

describe("RequestIdMiddleware Integration", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let redisPrefix: string
  let healthService: HealthService

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb, redisPrefix))
      .compile()

    app = module.createNestApplication({
      logger: new CustomLogger("test", {timestamp: false, logLevels: ["error", "warn"]})
    })
    prisma = module.get(DatabaseClient)
    healthService = module.get(HealthService)
    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await cleanRedisByPrefix(redisPrefix)
    await app.close()
  })

  it("should generate a valid traceparent if missing and populate RequestContext", async () => {
    const response = await get(app, "/health").build()

    expect(response.status).toBe(HttpStatus.OK)
    const traceparent = response.headers["traceparent"]
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  })

  it("should preserve traceId and generate new spanId from valid traceparent", async () => {
    const validTraceId = "4bf92f3577b34da6a3ce929d0e0e4736"
    const incomingParentId = "00f067aa0ba902b7"
    const validTraceparent = `00-${validTraceId}-${incomingParentId}-01`

    let capturedRequestId: string = ""
    jest.spyOn(healthService, "checkHealth").mockImplementation(() => {
      capturedRequestId = RequestContext.currentRequestId
      return TE.right(undefined)
    })

    const response = await get(app, "/health").build().set("traceparent", validTraceparent)

    expect(response.status).toBe(HttpStatus.OK)
    const traceparentHeader = response.headers["traceparent"]

    // Should preserve traceId but have a new spanId
    expect(traceparentHeader).toMatch(new RegExp(`^00-${validTraceId}-[0-9a-f]{16}-01$`))
    expect(traceparentHeader).not.toEqual(validTraceparent)
    expect(capturedRequestId).toBe(traceparentHeader)
  })

  it("should handle invalid traceparent by generating a new one", async () => {
    const response = await get(app, "/health").build().set("traceparent", "invalid-traceparent")

    expect(response.status).toBe(HttpStatus.OK)
    const traceparent = response.headers["traceparent"]
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  })
})
