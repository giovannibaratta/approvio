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
import {get, post, patch} from "@test/requests"
import {createAuthenticatedUserInDb, TestTokenBuilder} from "@test/token-helpers"
import {UserWithToken} from "@test/types"
import {QuotaRepository, QUOTA_REPOSITORY_TOKEN, UsageMeteringService} from "@services"
import {QuotaFactory, ALL_METERED_METRICS, formatBillingPeriod} from "@domain"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
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
        expect(body.quotas.MAX_SPACES).toBe("3")
        expect(body.quotas.MAX_GROUPS).toBe("5")
        expect(body.quotas.MAX_LLM_TOKENS_PER_MONTH).toBe("0")

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
            9007199254740993n
          )
        )
        const context = {organizationId: validOrgId}
        await transactionManager.execute(context, () => quotaRepo.createQuota(context, customQuota))()

        const response = await get(app, `${endpoint}/${validOrgId}/entitlements`).withToken(orgAdminUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body = response.body as OrganizationEntitlementsResponse
        expect(body.quotas.MAX_SPACES).toBe("9007199254740993")
        expect(body.quotas.MAX_GROUPS).toBe("5")
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

      it("returns 403 when the requested organization differs from the token's organization", async () => {
        const response = await get(app, `${endpoint}/${nonExistentOrgId}/entitlements`)
          .withToken(orgAdminUser.token)
          .build()

        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
        expect(response.body).toHaveErrorCode("ORGANIZATION_MISMATCH")
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
        // Prepare current-period caches by calling the rebuild service directly; no worker runs here.
        // Successful usage reads require ready caches. A separate test covers a cache miss returning 503.
        const metering = app.get(UsageMeteringService)
        const period = formatBillingPeriod(new Date())
        for (const metric of ALL_METERED_METRICS)
          unwrapRight(await metering.rebuildUsageCache({organizationId: validOrgId}, metric, period)())
      })

      it("uses exact metered quota overrides in quota APIs, entitlements, usage and admission", async () => {
        // Verify that an organization quota override above Number.MAX_SAFE_INTEGER stays exact through
        // quota creation, update, retrieval, and entitlements. Reserve the full updated limit through
        // the metering service, reject one additional unit, and verify that usage reports the same
        // decimal-string limit and reservation with zero remaining capacity.
        // Given
        const metric = "MAX_LLM_TOKENS_PER_MONTH" as const
        const limit = "9007199254740993"
        const quotaEndpoint = `${endpoint}/${validOrgId}/quotas`
        const updatedLimit = "9223372036854775807"
        const metering = app.get(UsageMeteringService)
        const operation = {
          organizationId: validOrgId,
          operationId: uuidv7(),
          expiresAt: new Date(Date.now() + 86400000),
          entity: {type: "Workflow", id: uuidv7()},
          actor: {type: "user" as const, id: orgAdminUser.user.id, displayName: orgAdminUser.user.displayName},
          metric,
          period: formatBillingPeriod(new Date()),
          estimatedUnits: 9223372036854775807n
        }

        // When: Create the organization quota override.
        const created = await post(app, quotaEndpoint).withToken(orgAdminUser.token).build().send({
          scope: "Org",
          targetId: validOrgId,
          quotaType: metric,
          limit
        })

        // Expect
        expect(created).toHaveStatusCode(HttpStatus.CREATED)
        expect(created.body.limit).toBe(limit)

        const id = created.body.id as string
        // When: Update the override to the larger limit.
        const updated = await patch(app, `${quotaEndpoint}/${id}`)
          .withToken(orgAdminUser.token)
          .build()
          .send({limit: updatedLimit})

        // Expect
        expect(updated).toHaveStatusCode(HttpStatus.OK)
        expect(updated.body.limit).toBe(updatedLimit)

        // When: Read the stored quota.
        const fetched = await get(app, `${quotaEndpoint}/${id}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(fetched).toHaveStatusCode(HttpStatus.OK)
        expect(fetched.body.limit).toBe(updatedLimit)

        // When: Read the effective entitlement.
        const entitlements = await get(app, `${endpoint}/${validOrgId}/entitlements`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect
        expect(entitlements).toHaveStatusCode(HttpStatus.OK)
        expect(entitlements.body.quotas[metric]).toBe(updatedLimit)

        // When: Reserve the full updated limit.
        const admitted = await metering.admitAndReserve(operation)()

        // Expect
        expect(admitted).toBeRight()

        // When: Request one additional unit.
        const denied = await metering.admitAndReserve({...operation, operationId: uuidv7(), estimatedUnits: 1n})()

        // Expect
        expect(denied).toBeLeftOf("quota_exceeded")

        // When: Read usage after reserving the full limit.
        const usage = await get(app, `${endpoint}/${validOrgId}/usage`)
          .withToken(orgAdminUser.token)
          .query({metric})
          .build()

        // Expect
        expect(usage).toHaveStatusCode(HttpStatus.OK)
        expect(usage.body.metrics[0]).toMatchObject({limit: updatedLimit, reserved: updatedLimit, remaining: "0"})
      })

      it("returns exact decimal quantities above the JavaScript safe integer range after cache recovery", async () => {
        // Given
        const metering = app.get(UsageMeteringService)
        const period = formatBillingPeriod(new Date())
        const metric = "MAX_LLM_TOKENS_PER_MONTH" as const
        const quantity = 9007199254740993n
        await prisma.organization.update({where: {id: validOrgId}, data: {planTier: "SELF_HOSTED_UNLIMITED"}})
        const operation = {
          organizationId: validOrgId,
          operationId: uuidv7(),
          expiresAt: new Date(Date.now() + 86400000),
          entity: {type: "Workflow", id: uuidv7()},
          actor: {type: "user" as const, id: orgAdminUser.user.id, displayName: orgAdminUser.user.displayName},
          metric,
          period,
          estimatedUnits: quantity
        }
        const reservation = await metering.admitAndReserve(operation)()
        unwrapRight(reservation)
        const settlement = await metering.settleUsage({...operation, actualUnits: quantity})()
        unwrapRight(settlement)
        const applied = await metering.applySettlement({organizationId: validOrgId}, operation.operationId)()
        unwrapRight(applied)
        await cleanRedisByPrefix(redisPrefix)
        const rebuilt = await metering.rebuildUsageCache({organizationId: validOrgId}, metric, period)()
        unwrapRight(rebuilt)

        // When
        const response = await get(app, `${endpoint}/${validOrgId}/usage`)
          .withToken(orgAdminUser.token)
          .query({metric})
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.metrics).toEqual([
          {metric, limit: null, consumed: "9007199254740993", reserved: "0", remaining: null, unit: "tokens"}
        ])
        const validation = validateOrganizationUsageResponse(response.body)
        expect(validation).toBeRight()
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

      it("returns 403 when the requested organization differs from the token's organization", async () => {
        const response = await get(app, `${endpoint}/${nonExistentOrgId}/usage`).withToken(orgAdminUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
        expect(response.body).toHaveErrorCode("ORGANIZATION_MISMATCH")
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
