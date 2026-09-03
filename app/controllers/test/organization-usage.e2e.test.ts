import {
  OrganizationEntitlementsResponse,
  OrganizationUsageResponse,
  validateOrganizationEntitlementsResponse,
  validateOrganizationUsageResponse
} from "@approvio/api"
import {AppModule} from "@app/app.module"
import {ORGANIZATIONS_ENDPOINT_ROOT} from "@controllers/organizations"
import {DatabaseClient} from "@external"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {createMockAgentInDb, MockConfigProvider} from "@test/mock-data"
import {get} from "@test/requests"
import {createAuthenticatedUserInDb, TestTokenBuilder} from "@test/token-helpers"
import {UserWithToken} from "@test/types"
import {DEFAULT_ORG_ID, QuotaRepository, QUOTA_REPOSITORY_TOKEN} from "@services"
import {QuotaFactory} from "@domain"
import {unwrapRight} from "@utils/either"
import {mapAgentToDomain} from "@external/database/shared"
import {isRight} from "fp-ts/Either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("Organizations API (Entitlements & Usage)", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let quotaRepo: QuotaRepository

  const endpoint = `/${ORGANIZATIONS_ENDPOINT_ROOT}`
  const validOrgId = DEFAULT_ORG_ID
  const nonExistentOrgId = uuidv7()

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(
        MockConfigProvider.fromOriginalProvider({
          dbConnectionUrl: isolatedDb,
          deploymentEdition: "saas_cloud",
          planTier: "FREE"
        })
      )
      .compile()

    app = module.createNestApplication({logger: false})

    prisma = module.get(DatabaseClient).prisma
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)
    quotaRepo = module.get<QuotaRepository>(QUOTA_REPOSITORY_TOKEN)

    await app.init()
  }, 30000)

  beforeEach(async () => {
    orgAdminUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})
    orgMemberUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: false})
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  describe("GET /organizations/:orgId/entitlements", () => {
    describe("good cases", () => {
      it("should return 200 and valid entitlements for authorized Admin caller", async () => {
        const response = await get(app, `${endpoint}/${validOrgId}/entitlements`).withToken(orgAdminUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body = response.body as OrganizationEntitlementsResponse
        expect(body.orgId).toBe(validOrgId)
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
        expect(body.orgId).toBe(validOrgId)
        const validation = validateOrganizationEntitlementsResponse(body)
        expect(isRight(validation)).toBe(true)
      })

      it("should reflect org-level quota overrides configured in the database", async () => {
        const customQuota = unwrapRight(
          QuotaFactory.newQuota({node: {type: "Org", identifier: validOrgId}, quotaType: "MAX_SPACES"}, 42)
        )
        await quotaRepo.createQuota(customQuota)()

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
        const agent = await createMockAgentInDb(prisma)
        const domainAgent = unwrapRight(mapAgentToDomain(agent))
        const agentToken = TestTokenBuilder.signAgentToken(jwtService, configProvider, domainAgent)

        const response = await get(app, `${endpoint}/${validOrgId}/entitlements`).withToken(agentToken).build()

        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      })

      it("should return 404 Not Found for non-existent organization", async () => {
        const response = await get(app, `${endpoint}/${nonExistentOrgId}/entitlements`)
          .withToken(orgAdminUser.token)
          .build()

        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
      })

      it("should return 400 Bad Request for malformed organization UUID", async () => {
        const response = await get(app, `${endpoint}/not-a-valid-uuid/entitlements`)
          .withToken(orgAdminUser.token)
          .build()

        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })
    })
  })

  describe("GET /organizations/:orgId/usage", () => {
    describe("good cases", () => {
      it("should return 200 and usage summary for authorized Admin caller (default active period)", async () => {
        const response = await get(app, `${endpoint}/${validOrgId}/usage`).withToken(orgAdminUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body = response.body as OrganizationUsageResponse
        expect(body.orgId).toBe(validOrgId)
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
      it("should return 403 Forbidden for non-admin Member caller", async () => {
        const response = await get(app, `${endpoint}/${validOrgId}/usage`).withToken(orgMemberUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      })

      it("should return 403 Forbidden for Agent caller", async () => {
        const agent = await createMockAgentInDb(prisma)
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

        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
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
