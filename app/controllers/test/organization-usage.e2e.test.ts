import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {
  OrganizationEntitlementsResponse,
  OrganizationUsageResponse,
  validateOrganizationEntitlementsResponse,
  validateOrganizationUsageResponse
} from "@approvio/api"
import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {createMockAgentInDb, MockConfigProvider} from "@test/mock-data"
import {get} from "@test/requests"
import {createAuthenticatedUserInDb, TestTokenBuilder} from "@test/token-helpers"
import {UserWithToken} from "@test/types"
import {QuotaRepository, QUOTA_REPOSITORY_TOKEN, UsageMeteringService} from "@services"
import {QuotaFactory, ALL_METERED_METRICS, formatBillingPeriod} from "@domain"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import {unwrapRight} from "@utils/either"
import {mapAgentToDomain} from "@external/database/shared"
import {isRight} from "fp-ts/Either"
import "@utils/matchers"

describe("Organizations API (Entitlements & Usage)", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let quotaRepo: QuotaRepository
  let transactionManager: TenantTransactionManager

  const endpoint = "/o"
  const redisPrefix = prepareRedisPrefix()
  const nonExistentOrgId = randomOrgId()
  let validOrgId: ReturnType<typeof toOrganizationId>

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(
        MockConfigProvider.fromOriginalProvider({
          tenantConnectionUrl: isolatedDb,
          deploymentEdition: "saas_cloud",
          redisPrefix
        })
      )
      .compile()

    app = module.createNestApplication({logger: false})

    prisma = createFixturePrismaClient(isolatedDb)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)
    quotaRepo = module.get<QuotaRepository>(QUOTA_REPOSITORY_TOKEN)
    transactionManager = module.get(TRANSACTION_MANAGER_TOKEN)

    await app.init()
  }, 30000)

  beforeEach(async () => {
    orgAdminUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})
    validOrgId = orgAdminUser.user.organizationId
    orgMemberUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      orgAdmin: false,
      organizationId: validOrgId
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
    await cleanRedisByPrefix(redisPrefix)
  })

  describe("GET /o/:organizationId/entitlements", () => {
    describe("good cases", () => {
      it("should return 200 and valid entitlements for authorized Admin caller", async () => {
        const response = await get(app, `${endpoint}/${validOrgId}/entitlements`).withToken(orgAdminUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body = response.body as OrganizationEntitlementsResponse
        expect(body.organizationId).toBe(validOrgId)
        expect(body.planTier).toBe("FREE")
        expect(body.edition).toBe("saas_cloud")
        expect(body.features.platformLlmEvaluators).toBe(false)
        expect(body.quotas).toBeDefined()
        expect(body.quotas.MAX_SPACES).toBe(3)
        expect(body.quotas.MAX_GROUPS).toBe(5)
        expect(body.quotas.MAX_LLM_TOKENS_PER_MONTH).toBe(0)

        const validation = validateOrganizationEntitlementsResponse(body)
        expect(isRight(validation)).toBe(true)
      })

      it("should return 200 and valid entitlements for authorized Member caller", async () => {
        const response = await get(app, `${endpoint}/${validOrgId}/entitlements`).withToken(orgMemberUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body = response.body as OrganizationEntitlementsResponse
        expect(body.organizationId).toBe(validOrgId)
        const validation = validateOrganizationEntitlementsResponse(body)
        expect(isRight(validation)).toBe(true)
      })

      it("should reflect org-level quota overrides configured in the database", async () => {
        const customQuota = unwrapRight(
          QuotaFactory.newQuota(
            {organizationId: validOrgId, node: {type: "Org", identifier: validOrgId}, quotaType: "MAX_SPACES"},
            42
          )
        )
        const context = {organizationId: validOrgId}
        await transactionManager.execute(context, () => quotaRepo.createQuota(context, customQuota))()

        const response = await get(app, `${endpoint}/${validOrgId}/entitlements`).withToken(orgAdminUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body = response.body as OrganizationEntitlementsResponse
        expect(body.quotas.MAX_SPACES).toBe(42)
        expect(body.quotas.MAX_GROUPS).toBe(5)
      })
    })

    describe("bad / unauthorized cases", () => {
      it("should return 401 Unauthorized for unauthenticated caller", async () => {
        const response = await get(app, `${endpoint}/${validOrgId}/entitlements`).build()

        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 403 Forbidden for Agent caller", async () => {
        const agent = await createMockAgentInDb(prisma, {organizationId: validOrgId})
        const domainAgent = unwrapRight(mapAgentToDomain(agent))
        const agentToken = TestTokenBuilder.signAgentToken(jwtService, configProvider, domainAgent)

        const response = await get(app, `${endpoint}/${validOrgId}/entitlements`).withToken(agentToken).build()

        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      })

      it("should return 404 Not Found for non-existent organization", async () => {
        const response = await get(app, `${endpoint}/${nonExistentOrgId}/entitlements`)
          .withToken(orgAdminUser.token)
          .build()

        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      })

      it("should return 400 Bad Request for malformed organization UUID", async () => {
        const response = await get(app, `${endpoint}/not-a-valid-uuid/entitlements`)
          .withToken(orgAdminUser.token)
          .build()

        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })
    })
  })

  describe("GET /o/:organizationId/usage", () => {
    describe("good cases", () => {
      beforeEach(async () => {
        // Given: background recovery has rebuilt the current period before these successful reads.
        const metering = app.get(UsageMeteringService)
        const period = formatBillingPeriod(new Date())
        for (const metric of ALL_METERED_METRICS)
          unwrapRight(await metering.rebuildUsageCache({organizationId: validOrgId}, metric, period)())
      })

      it("should return 200 and usage summary for authorized Admin caller (default active period)", async () => {
        const response = await get(app, `${endpoint}/${validOrgId}/usage`).withToken(orgAdminUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body = response.body as OrganizationUsageResponse
        expect(body.organizationId).toBe(validOrgId)
        expect(body.period).toMatch(/^\d{4}-\d{2}$/)
        expect(body.periodStartsAt).toBeDefined()
        expect(body.periodEndsAt).toBeDefined()
        expect(Array.isArray(body.metrics)).toBe(true)
        expect(body.metrics.length).toBeGreaterThan(0)

        const validation = validateOrganizationUsageResponse(body)
        expect(isRight(validation)).toBe(true)
      })

      it("should return 200 and usage summary when explicit period query param is provided", async () => {
        const period = "2026-08"
        const response = await get(app, `${endpoint}/${validOrgId}/usage`)
          .withToken(orgAdminUser.token)
          .query({period})
          .build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body = response.body as OrganizationUsageResponse
        expect(body.period).toBe(period)
        expect(body.periodStartsAt).toBe("2026-08-01T00:00:00.000Z")
        expect(body.periodEndsAt).toBe("2026-08-31T23:59:59.999Z")

        const validation = validateOrganizationUsageResponse(body)
        expect(isRight(validation)).toBe(true)
      })

      it("should return 200 and filter to single metric when metric query param is provided", async () => {
        const metric = "MAX_LLM_TOKENS_PER_MONTH"
        const response = await get(app, `${endpoint}/${validOrgId}/usage`)
          .withToken(orgAdminUser.token)
          .query({metric})
          .build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body = response.body as OrganizationUsageResponse
        expect(body.metrics).toHaveLength(1)
        expect(body.metrics[0]!.metric).toBe(metric)
        expect(body.metrics[0]!.unit).toBe("tokens")

        const validation = validateOrganizationUsageResponse(body)
        expect(isRight(validation)).toBe(true)
      })
    })

    describe("bad / unauthorized cases", () => {
      it("should return 503 while current-period cache recovery is pending", async () => {
        // Given: this organization's Redis namespace is empty; no recovery has run.
        // When: an authorized administrator requests current-period usage.
        const response = await get(app, `${endpoint}/${validOrgId}/usage`).withToken(orgAdminUser.token).build()

        // Expect: an unavailable cache cannot be reported as zero usage.
        expect(response).toHaveStatusCode(HttpStatus.SERVICE_UNAVAILABLE)
        expect(response.body).toHaveErrorCode("QUOTA_CACHE_UNAVAILABLE")
      })

      it("should return 403 Forbidden for non-admin Member caller", async () => {
        const response = await get(app, `${endpoint}/${validOrgId}/usage`).withToken(orgMemberUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      })

      it("should return 403 Forbidden for Agent caller", async () => {
        const agent = await createMockAgentInDb(prisma, {organizationId: validOrgId})
        const domainAgent = unwrapRight(mapAgentToDomain(agent))
        const agentToken = TestTokenBuilder.signAgentToken(jwtService, configProvider, domainAgent)

        const response = await get(app, `${endpoint}/${validOrgId}/usage`).withToken(agentToken).build()

        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      })

      it("should return 401 Unauthorized for unauthenticated caller", async () => {
        const response = await get(app, `${endpoint}/${validOrgId}/usage`).build()

        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 404 Not Found for non-existent organization", async () => {
        const response = await get(app, `${endpoint}/${nonExistentOrgId}/usage`).withToken(orgAdminUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      })

      it("should return 400 Bad Request for malformed organization UUID", async () => {
        const response = await get(app, `${endpoint}/invalid-uuid/usage`).withToken(orgAdminUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 Bad Request for invalid period format", async () => {
        const response = await get(app, `${endpoint}/${validOrgId}/usage`)
          .withToken(orgAdminUser.token)
          .query({period: "2026-13"})
          .build()

        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 Bad Request for invalid metric name", async () => {
        const response = await get(app, `${endpoint}/${validOrgId}/usage`)
          .withToken(orgAdminUser.token)
          .query({metric: "INVALID_METRIC"})
          .build()

        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })
    })
  })
})
