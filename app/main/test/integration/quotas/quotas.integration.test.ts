import {toOrganizationId} from "@test/organization-id"
import {v7 as uuidv7} from "uuid"
import {Test, TestingModule} from "@nestjs/testing"
import {NestApplication} from "@nestjs/core"
import {HttpStatus} from "@nestjs/common"
import {AppModule} from "@app/app.module"
import {createMockQuotaInDb, MockConfigProvider} from "@test/mock-data"
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {PrismaClient} from "@prisma/client"
import {ConfigProvider} from "@external/config"
import {JwtService} from "@nestjs/jwt"
import {get, post, patch, del} from "@test/requests"
import {QuotaCreate, QuotaUpdate} from "@approvio/api"
import "@utils/matchers"
import {QUOTA_REPOSITORY_TOKEN, QuotaRepository} from "@services"
import {wrapTaskEitherWithSideEffect} from "@test/injectors"

describe("Quotas Integration Tests", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let adminToken: string
  let userToken: string
  let organizationId: ReturnType<typeof toOrganizationId>
  let endpoint: string

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromOriginalProvider({tenantConnectionUrl: isolatedDb}))
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(isolatedDb)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)

    await app.init()
  }, 30000)

  beforeEach(async () => {
    // Setup users and tokens
    const adminUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})
    const regularUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      orgAdmin: false,
      organizationId: adminUser.user.organizationId
    })

    adminToken = adminUser.token
    userToken = regularUser.token
    organizationId = adminUser.user.organizationId
    endpoint = `/o/${organizationId}/quotas`
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  describe("POST /quotas", () => {
    it("should allow admin to create a global quota", async () => {
      // Given
      const payload: QuotaCreate = {
        scope: "Org",
        quotaType: "MAX_GROUPS",
        limit: 10,
        targetId: organizationId
      }

      // When
      const response = await post(app, endpoint).withToken(adminToken).build().send(payload)

      // Then
      expect(response).toHaveStatusCode(HttpStatus.CREATED)
      expect(response.body).toMatchObject({
        scope: "Org",
        quotaType: "MAX_GROUPS",
        limit: 10,
        targetId: organizationId
      })
    })

    it("should reject an organization-level target that disagrees with the route tenant", async () => {
      const response = await post(app, endpoint)
        .withToken(adminToken)
        .build()
        .send({scope: "Org", quotaType: "MAX_GROUPS", limit: 10, targetId: uuidv7()})

      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      expect(response.body).toHaveErrorCode("QUOTA_INVALID_TARGET_ID")
    })

    it("should allow admin to create a targeted quota (MAX_ENTITIES_PER_GROUP)", async () => {
      // Given
      const targetId = uuidv7()
      const payload: QuotaCreate = {
        scope: "Group",
        quotaType: "MAX_ENTITIES_PER_GROUP",
        limit: 5,
        targetId
      }

      // When
      const response = await post(app, endpoint).withToken(adminToken).build().send(payload).expect(HttpStatus.CREATED)

      // Then
      expect(response.body).toMatchObject({
        scope: "Group",
        quotaType: "MAX_ENTITIES_PER_GROUP",
        limit: 5,
        targetId
      })
    })

    it("should reject creation by non-admin user", async () => {
      // Given
      const payload: QuotaCreate = {
        scope: "Org",
        quotaType: "MAX_GROUPS",
        limit: 10,
        targetId: organizationId
      }

      // When
      const response = await post(app, endpoint).withToken(userToken).build().send(payload)

      // Then
      expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      expect(response.body).toHaveErrorCode("REQUESTOR_NOT_AUTHORIZED")
    })
  })

  describe("GET /quotas", () => {
    it("should list quotas", async () => {
      // Given: some quotas exist
      await createMockQuotaInDb(prisma, {
        organizationId,
        scope: "Org",
        quotaType: "MAX_GROUPS"
      })

      // When
      const response = await get(app, endpoint).withToken(adminToken).build().expect(HttpStatus.OK)

      // Then
      expect(response.body.data).toHaveLength(1)
      expect(response.body.data[0]).toMatchObject({
        quotaType: "MAX_GROUPS"
      })
    })

    it("should filter quotas by scope", async () => {
      // Given
      await createMockQuotaInDb(prisma, {
        organizationId,
        scope: "Org",
        quotaType: "MAX_GROUPS"
      })
      await createMockQuotaInDb(prisma, {
        organizationId,
        scope: "Group",
        quotaType: "MAX_ENTITIES_PER_GROUP"
      })

      // When
      const response = await get(app, endpoint)
        .query({scope: "Group"})
        .withToken(adminToken)
        .build()
        .expect(HttpStatus.OK)

      // Then
      expect(response.body.data).toHaveLength(1)
      expect(response.body.data[0].scope).toBe("Group")
    })

    it("should return no quotas for a different organization target", async () => {
      await createMockQuotaInDb(prisma, {
        organizationId,
        scope: "Org",
        quotaType: "MAX_GROUPS"
      })

      const response = await get(app, endpoint)
        .query({scope: "Org", targetId: uuidv7()})
        .withToken(adminToken)
        .build()
        .expect(HttpStatus.OK)

      expect(response.body.data).toHaveLength(0)
    })
  })

  describe("GET /quotas/:id", () => {
    it("should retrieve a quota by id", async () => {
      // Given
      const quota = await createMockQuotaInDb(prisma, {organizationId})

      // When
      const response = await get(app, `${endpoint}/${quota.id}`).withToken(adminToken).build().expect(HttpStatus.OK)

      // Then
      expect(response.body.id).toBe(quota.id)
    })
  })

  describe("PATCH /quotas/:id", () => {
    it("should update quota limit", async () => {
      // Given
      const quota = await createMockQuotaInDb(prisma, {
        organizationId,
        limit: 10
      })

      // When
      const payload: QuotaUpdate = {limit: 50}

      // Then
      const response = await patch(app, `${endpoint}/${quota.id}`)
        .withToken(adminToken)
        .build()
        .send(payload)
        .expect(HttpStatus.OK)

      expect(response.body.limit).toBe(50)
    })

    it("should allow patching with an empty body (limit should be optional)", async () => {
      // Given
      const quota = await createMockQuotaInDb(prisma, {organizationId})

      // When: sending empty body
      const response = await patch(app, `${endpoint}/${quota.id}`)
        .withToken(adminToken)
        .build()
        .send({})
        .expect(HttpStatus.OK)

      // Then: limit should remain 10
      expect(response.body.limit).toBe(10)
    })

    describe("race conditions", () => {
      let spy: jest.SpiedFunction<QuotaRepository["getQuotaById"]> | undefined

      afterEach(() => {
        spy?.mockRestore()
      })

      it("should return 409 Conflict if OCC condition fails during quota update", async () => {
        const repo = app.get<QuotaRepository>(QUOTA_REPOSITORY_TOKEN)

        const quota = await createMockQuotaInDb(prisma, {organizationId})

        // Intercept getQuotaById to trigger concurrent modification
        spy = wrapTaskEitherWithSideEffect(repo, "getQuotaById", async (_context, id) => {
          if (id === quota.id)
            await prisma.quota.update({
              where: {id: quota.id},
              data: {occ: {increment: 1}}
            })
        })

        const payload: QuotaUpdate = {limit: 50}

        const response = await patch(app, `${endpoint}/${quota.id}`).withToken(adminToken).build().send(payload)

        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body.code).toBe("QUOTA_CONCURRENT_MODIFICATION_ERROR")
      })
    })
  })

  describe("DELETE /quotas/:id", () => {
    it("should delete a quota", async () => {
      // Given
      const quota = await createMockQuotaInDb(prisma, {organizationId})

      // When
      await del(app, `${endpoint}/${quota.id}`).withToken(adminToken).build().expect(HttpStatus.NO_CONTENT)

      // Then
      const deleted = await prisma.quota.findUnique({where: {id: quota.id}})
      expect(deleted).toBeNull()
    })
  })
})
