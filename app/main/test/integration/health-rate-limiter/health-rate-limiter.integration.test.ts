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
import {HealthRateLimiterGuard} from "@app/rate-limiter"

describe("Health API Rate Limiting", () => {
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
    // Enable trust proxy to test different client IPs via X-Forwarded-For header
    app.getHttpAdapter().getInstance().set("trust proxy", true)
    prisma = module.get(DatabaseClient).prisma
    await app.init()
  }, 30000)

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    // Clear the guard's in-memory rate limiter to avoid test interference
    const guard = app.get(HealthRateLimiterGuard)
    await guard.rateLimiter.delete("1.1.1.1")
    await guard.rateLimiter.delete("2.2.2.2")

    await cleanDatabase(prisma)
    await cleanRedisByPrefix(redisPrefix)
  })

  it("should rate limit requests to /internal/health", async () => {
    const guard = app.get(HealthRateLimiterGuard)

    // First request from IP 1 should succeed
    let response = await get(app, "/internal/health").build().set("X-Forwarded-For", "1.1.1.1")
    expect(response).toHaveStatusCode(HttpStatus.OK)
    expect(response.headers).toHaveProperty("ratelimit")
    expect(response.headers).toHaveProperty("ratelimit-policy")

    // Second request from IP 1 within the same second should be rate limited
    response = await get(app, "/internal/health").build().set("X-Forwarded-For", "1.1.1.1")
    expect(response).toHaveStatusCode(HttpStatus.TOO_MANY_REQUESTS)
    expect(response.body).toHaveProperty("code", "TOO_MANY_REQUESTS")

    // Request from a different IP (IP 2) should succeed
    response = await get(app, "/internal/health").build().set("X-Forwarded-For", "2.2.2.2")
    expect(response).toHaveStatusCode(HttpStatus.OK)

    // Reset rate limiter for IP 1
    await guard.rateLimiter.delete("1.1.1.1")

    // Request from IP 1 should succeed again
    response = await get(app, "/internal/health").build().set("X-Forwarded-For", "1.1.1.1")
    expect(response).toHaveStatusCode(HttpStatus.OK)
  })
})
