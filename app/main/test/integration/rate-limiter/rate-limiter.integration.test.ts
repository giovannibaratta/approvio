import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {DatabaseClient} from "@external"
import {cleanDatabase, cleanRedisByPrefix, prepareDatabase, prepareRedisPrefix} from "@test/database"
import {createDomainMockUserInDb, MockConfigProvider} from "@test/mock-data"
import {get} from "@test/requests"
import {UserWithToken} from "@test/types"
import {TokenPayloadBuilder} from "@services"

const RATE_LIMIT_POINTS = 3
// Use 10 minutes to avoid test flakiness
const RATE_LIMIT_DURATION_SECONDS = 600

// Use an authenticated endpoint to test the rate limiter.
// Public routes (e.g. /health) bypass the JwtAuthGuard and never set request.user,
// so the rate limiter guard skips them.
const AUTHENTICATED_ENDPOINT = "/auth/info"

describe("Rate Limiter Integration", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let redisPrefix: string

  let authenticatedUser: UserWithToken

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    if (!process.env.REDIS_HOST) throw new Error("REDIS_HOST is not defined")
    if (!process.env.REDIS_PORT) throw new Error("REDIS_PORT is not defined")
    if (!process.env.REDIS_DB) throw new Error("REDIS_DB is not defined")

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(
        MockConfigProvider.fromOriginalProvider({
          dbConnectionUrl: isolatedDb,
          redisPrefix,
          rateLimitConfig: {
            points: RATE_LIMIT_POINTS,
            durationInSeconds: RATE_LIMIT_DURATION_SECONDS,
            redis: {
              host: process.env.REDIS_HOST,
              port: parseInt(process.env.REDIS_PORT),
              db: parseInt(process.env.REDIS_DB),
              prefix: redisPrefix
            }
          }
        })
      )
      .compile()

    app = module.createNestApplication({logger: ["error", "warn"]})
    prisma = module.get(DatabaseClient)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)

    const user = await createDomainMockUserInDb(prisma)
    const tokenPayload = TokenPayloadBuilder.fromUser(user, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })

    authenticatedUser = {user, token: jwtService.sign(tokenPayload)}

    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await cleanRedisByPrefix(redisPrefix)
    await app.close()
  })

  it("should not rate-limit unauthenticated requests", async () => {
    // Public routes bypass the rate limiter even after many requests
    for (let i = 0; i < RATE_LIMIT_POINTS + 2; i++) {
      const response = await get(app, "/health").build()
      expect(response).not.toHaveStatusCode(HttpStatus.TOO_MANY_REQUESTS)
    }
  })

  it("should allow authenticated requests within the limit and return IETF rate limit headers", async () => {
    const response = await get(app, AUTHENTICATED_ENDPOINT).withToken(authenticatedUser.token).build()

    expect(response).toHaveStatusCode(HttpStatus.OK)

    // Verify IETF standard rate limit headers (supertest lowercases header names)
    const rateLimitHeader = response.headers["ratelimit"]
    expect(rateLimitHeader).toContain(`limit=${RATE_LIMIT_POINTS}`)
    expect(rateLimitHeader).toContain("remaining=")
    expect(rateLimitHeader).toContain("reset=")
    expect(response.headers["ratelimit-policy"]).toBe(`${RATE_LIMIT_POINTS};w=${RATE_LIMIT_DURATION_SECONDS}`)
    expect(response.headers["retry-after"]).toBeDefined()
  })

  it("should return 429 TOO_MANY_REQUESTS when exceeding the limit", async () => {
    // Exhaust the rate limit quota
    for (let i = 0; i < RATE_LIMIT_POINTS; i++) {
      const response = await get(app, AUTHENTICATED_ENDPOINT).withToken(authenticatedUser.token).build()
      expect(response).toHaveStatusCode(HttpStatus.OK)
    }

    // The next request should be rejected
    const blockedResponse = await get(app, AUTHENTICATED_ENDPOINT).withToken(authenticatedUser.token).build()

    expect(blockedResponse).toHaveStatusCode(HttpStatus.TOO_MANY_REQUESTS)
    expect(blockedResponse.body).toHaveErrorCode("TOO_MANY_REQUESTS")
  })

  it("should enforce rate limits per entity (different users have independent quotas)", async () => {
    // Given: A second user with an independent quota
    const secondUser = await createDomainMockUserInDb(prisma)
    const secondTokenPayload = TokenPayloadBuilder.fromUser(secondUser, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })
    const secondUserToken = jwtService.sign(secondTokenPayload)

    // When: Exhaust the first user's quota
    for (let i = 0; i < RATE_LIMIT_POINTS; i++) {
      await get(app, AUTHENTICATED_ENDPOINT).withToken(authenticatedUser.token).build()
    }

    // Expect: First user is blocked
    const blockedResponse = await get(app, AUTHENTICATED_ENDPOINT).withToken(authenticatedUser.token).build()
    expect(blockedResponse).toHaveStatusCode(HttpStatus.TOO_MANY_REQUESTS)

    // Expect: Second user is still allowed
    const secondUserResponse = await get(app, AUTHENTICATED_ENDPOINT).withToken(secondUserToken).build()
    expect(secondUserResponse).toHaveStatusCode(HttpStatus.OK)
  })
})
