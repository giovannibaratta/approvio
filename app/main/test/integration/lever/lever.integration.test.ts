import {AppModule} from "@app/app.module"
import {ConfigProvider, OidcProviderConfig} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {Test} from "@nestjs/testing"
import {cleanRedisByPrefix, prepareDatabase, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {get, post} from "@test/requests"
import {PrismaClient} from "@prisma/client"
import {DatabaseClient} from "@external"
import {mapToUnleashFeatures} from "@external/config/lever-bootstrap.utils"
import {FeatureInterface} from "unleash-client/lib/feature"
import {Operator} from "unleash-client/lib/strategy/strategy"

interface CreateTestingModuleOptions {
  levers?: Record<string, boolean>
  features?: FeatureInterface[]
  additionalOidcProviders?: Map<string, OidcProviderConfig>
}

describe("Lever Integration (Real Provider)", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let redisPrefix: string

  jest.setTimeout(30000)

  // Helper to create a testing module with specific lever states
  const createTestingModule = async (options: CreateTestingModuleOptions) => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    const mockConfig = MockConfigProvider.fromDbConnectionUrl(isolatedDb, redisPrefix)

    if (options.additionalOidcProviders)
      for (const [id, config] of options.additionalOidcProviders.entries()) mockConfig.oidcProviders.set(id, config)

    const bootstrapData = options.features ?? (options.levers ? mapToUnleashFeatures(options.levers) : [])

    // Configure the real provider with bootstrap data
    mockConfig.leverConfig = {
      enabled: true,
      provider: "unleash",
      unleashUrl: "http://localhost:1234/api/doesnotexist", // Use non-existent port to force offline mode
      refreshInterval: 0, // Disable polling to avoid unhandled ECONNREFUSED errors
      bootstrapData
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
      const module = await createTestingModule({levers: {read_only_mode: true}})
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
      const module = await createTestingModule({levers: {read_only_mode: false}})
      app = module.createNestApplication({logger: false})
      prisma = module.get(DatabaseClient).prisma
      await app.init()

      const response = await post(app, "/spaces").build().send({name: "Should Pass"})

      // Should not be 503 (it will fail later with 401/403 due to missing token, but that means it passed the middleware)
      expect(response.status).not.toBe(HttpStatus.SERVICE_UNAVAILABLE)
    })
  })

  describe("Auth Providers Lever (disable_auth_provider)", () => {
    it("should exclude disabled providers from GET /auth/providers when disable_auth_provider is active in bootstrap", async () => {
      // Given: System is bootstrapped with disable_auth_provider enabled
      const module = await createTestingModule({levers: {disable_auth_provider: true}})
      app = module.createNestApplication({logger: false})
      prisma = module.get(DatabaseClient).prisma
      await app.init()

      // When: Fetching available authentication providers
      const response = await get(app, "/auth/providers").build()

      // Then: All providers are disabled and excluded
      expect(response.status).toBe(HttpStatus.OK)
      expect(response.body).toEqual([])
    })

    it("should include available providers when disable_auth_provider is inactive in bootstrap", async () => {
      // Given: System is bootstrapped with disable_auth_provider disabled
      const module = await createTestingModule({levers: {disable_auth_provider: false}})
      app = module.createNestApplication({logger: false})
      prisma = module.get(DatabaseClient).prisma
      await app.init()

      // When: Fetching available authentication providers
      const response = await get(app, "/auth/providers").build()

      // Then: Available providers are returned
      expect(response.status).toBe(HttpStatus.OK)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBeGreaterThan(0)
    })

    it("should disable only targeted provider when Unleash constraint matches providerId", async () => {
      // Given: disable_auth_provider is configured in Unleash with a constraint targeting only "okta"
      const targetedFeature: FeatureInterface = {
        name: "disable_auth_provider",
        enabled: true,
        type: "operational",
        strategies: [
          {
            name: "default",
            parameters: {},
            constraints: [
              {
                contextName: "providerId",
                operator: Operator.IN,
                inverted: false,
                values: ["okta"]
              }
            ]
          }
        ]
      }

      const additionalOidcProviders = new Map<string, OidcProviderConfig>([
        [
          "okta",
          {
            provider: "custom",
            issuerUrl: "http://localhost:4011",
            clientId: "okta-client-id",
            clientSecret: "okta-client-secret",
            redirectUri: "http://localhost:3000/auth/web/callback",
            displayName: "Okta",
            allowInsecure: true
          }
        ]
      ])

      const module = await createTestingModule({features: [targetedFeature], additionalOidcProviders})
      app = module.createNestApplication({logger: false})
      prisma = module.get(DatabaseClient).prisma
      await app.init()

      // When: Fetching available authentication providers
      const response = await get(app, "/auth/providers").build()

      // Then: "okta" is filtered out by Unleash constraint evaluation, while "custom" remains enabled
      expect(response.status).toBe(HttpStatus.OK)
      expect(response.body).toHaveLength(1)
      expect(response.body[0]).toMatchObject({
        id: "custom",
        displayName: "Custom OIDC"
      })
    })
  })
})
