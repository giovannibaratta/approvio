import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {Test, TestingModule} from "@nestjs/testing"
import {cleanDatabase, cleanRedisByPrefix, prepareDatabase, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {get} from "@test/requests"
import {DatabaseClient} from "@external"
import {PrismaClient} from "@prisma/client"
import {RequestContext} from "@app/logging/request-context"
import {PingController} from "@controllers/ping/ping.controller"

describe("RequestIdMiddleware Integration", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let redisPrefix: string
  let capturedRequestId = ""

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb, redisPrefix))
      .compile()

    app = module.createNestApplication({
      logger: false
    })
    prisma = module.get(DatabaseClient).prisma

    // Read NestJS controller metadata before replacing the method with a Jest spy
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalGetPing = PingController.prototype.getPing
    const keys = Reflect.getMetadataKeys(originalGetPing)
    const metadataMap = new Map(keys.map(key => [key, Reflect.getMetadata(key, originalGetPing)]))

    const spy = jest.spyOn(PingController.prototype, "getPing").mockImplementation(() => {
      capturedRequestId = RequestContext.currentRequestId
      return {status: "OK"}
    })

    // Restore NestJS routing metadata to the spy function
    metadataMap.forEach((meta, key) => {
      Reflect.defineMetadata(key, meta, spy)
    })

    await app.init()
  }, 30000)

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    capturedRequestId = ""
    await cleanDatabase(prisma)
    await cleanRedisByPrefix(redisPrefix)
  })

  it("should generate a valid traceparent if missing and populate RequestContext", async () => {
    const response = await get(app, "/ping").build()

    expect(response.status).toBe(HttpStatus.OK)
    const traceparent = response.headers["traceparent"]
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(capturedRequestId).toBe(traceparent)
  })

  it("should preserve traceId and generate new spanId from valid traceparent", async () => {
    const validTraceId = "4bf92f3577b34da6a3ce929d0e0e4736"
    const incomingParentId = "00f067aa0ba902b7"
    const validTraceparent = `00-${validTraceId}-${incomingParentId}-01`

    const response = await get(app, "/ping").build().set("traceparent", validTraceparent)

    expect(response.status).toBe(HttpStatus.OK)
    const traceparentHeader = response.headers["traceparent"]

    // Should preserve traceId but have a new spanId
    expect(traceparentHeader).toMatch(new RegExp(`^00-${validTraceId}-[0-9a-f]{16}-01$`))
    expect(traceparentHeader).not.toEqual(validTraceparent)
    expect(capturedRequestId).toBe(traceparentHeader)
  })

  it("should handle invalid traceparent by generating a new one", async () => {
    const response = await get(app, "/ping").build().set("traceparent", "invalid-traceparent")

    expect(response.status).toBe(HttpStatus.OK)
    const traceparent = response.headers["traceparent"]
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  })
})
