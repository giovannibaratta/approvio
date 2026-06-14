import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {Test} from "@nestjs/testing"
import {cleanRedisByPrefix, prepareDatabase, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {post} from "@test/requests"
import {PrismaClient} from "@prisma/client"
import {DatabaseClient} from "@external"
import {mapToUnleashFeatures} from "@external/config/lever-bootstrap.utils"

describe("Lever Integration (Real Provider)", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let redisPrefix: string

  jest.setTimeout(30000)

  // Helper to create a testing module with specific lever states
  const createTestingModule = async (levers: Record<string, boolean>) => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    const mockConfig = MockConfigProvider.fromDbConnectionUrl(isolatedDb, redisPrefix)

    // Configure the real provider with bootstrap data
    mockConfig.leverConfig = {
      enabled: true,
      provider: "unleash",
      unleashUrl: "http://localhost:1234/api/doesnotexist", // Use non-existent port to force offline mode
      refreshInterval: 0, // Disable polling to avoid unhandled ECONNREFUSED errors
      bootstrapData: mapToUnleashFeatures(levers)
    }

    return await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(mockConfig)
      .compile()
  }

  afterEach(async () => {
    if (prisma) await prisma.$disconnect()
    if (app) await app.close()
    await cleanRedisByPrefix(redisPrefix)
  })

  describe("LeverMiddleware (read_only_mode)", () => {
    it("should block POST requests when read_only_mode is active in bootstrap", async () => {
      // Given: System is bootstrapped in read-only mode
      const module = await createTestingModule({read_only_mode: true})
      app = module.createNestApplication({logger: false})
      prisma = module.get(DatabaseClient).prisma
      await app.init()

      // When: We attempt a POST request
      const response = await post(app, "/spaces").build().send({name: "Should Fail"})

      // Then: It should be blocked by the real middleware evaluating the real provider
      expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
      expect(response.body.code).toBe("SERVICE_UNAVAILABLE")
    })

    it("should allow POST requests when read_only_mode is inactive in bootstrap", async () => {
      // Given: System is bootstrapped with read-only mode disabled
      const module = await createTestingModule({read_only_mode: false})
      app = module.createNestApplication({logger: false})
      prisma = module.get(DatabaseClient).prisma
      await app.init()

      const response = await post(app, "/spaces").build().send({name: "Should Pass"})

      // Should not be 503 (it will fail later with 401/403 due to missing token, but that means it passed the middleware)
      expect(response.status).not.toBe(HttpStatus.SERVICE_UNAVAILABLE)
    })
  })
})
