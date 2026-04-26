import {Test, TestingModule} from "@nestjs/testing"
import {NestApplication} from "@nestjs/core"
import {HttpStatus} from "@nestjs/common"
import {AppModule} from "@app/app.module"
import {createDomainMockUserInDb, MockConfigProvider} from "@test/mock-data"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {DEFAULT_ORG_ID, TokenPayloadBuilder} from "@services"
import {PrismaClient} from "@prisma/client"
import {ConfigProvider} from "@external/config"
import {JwtService} from "@nestjs/jwt"
import {DatabaseClient} from "@external"
import {get, post, patch, del} from "@test/requests"
import {QuotaCreate, QuotaUpdate} from "@approvio/api"
import "@utils/matchers"
import {Chance} from "chance"

const chance = new Chance()

describe("Quotas Integration Tests", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let adminToken: string
  let userToken: string

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication({logger: false})
    prisma = module.get(DatabaseClient)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)

    // Setup users and tokens
    const adminUser = await createDomainMockUserInDb(prisma, {orgAdmin: true})
    const regularUser = await createDomainMockUserInDb(prisma, {orgAdmin: false})

    adminToken = jwtService.sign(
      TokenPayloadBuilder.from({
        sub: adminUser.id,
        entityType: "user",
        displayName: adminUser.displayName,
        email: adminUser.email,
        issuer: configProvider.jwtConfig.issuer,
        audience: [configProvider.jwtConfig.audience]
      })
    )

    userToken = jwtService.sign(
      TokenPayloadBuilder.from({
        sub: regularUser.id,
        entityType: "user",
        displayName: regularUser.displayName,
        email: regularUser.email,
        issuer: configProvider.jwtConfig.issuer,
        audience: [configProvider.jwtConfig.audience]
      })
    )

    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  describe("POST /quotas", () => {
    it("should allow admin to create a global quota", async () => {
      // Given
      const payload: QuotaCreate = {
        scope: "Org",
        quotaType: "MAX_GROUPS",
        limit: 10,
        targetId: DEFAULT_ORG_ID
      }

      // When
      const response = await post(app, "/quotas").withToken(adminToken).build().send(payload)

      // Then
      expect(response).toHaveStatusCode(HttpStatus.CREATED)
      expect(response.body).toMatchObject({
        scope: "Org",
        quotaType: "MAX_GROUPS",
        limit: 10,
        targetId: DEFAULT_ORG_ID
      })
    })

    it("should allow admin to create a targeted quota (MAX_ENTITIES_PER_GROUP)", async () => {
      // Given
      const targetId = "00000000-0000-0000-0000-000000000001"
      const payload: QuotaCreate = {
        scope: "Group",
        quotaType: "MAX_ENTITIES_PER_GROUP",
        limit: 5,
        targetId
      }

      // When
      const response = await post(app, "/quotas").withToken(adminToken).build().send(payload).expect(HttpStatus.CREATED)

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
        targetId: DEFAULT_ORG_ID
      }

      // When
      const response = await post(app, "/quotas").withToken(userToken).build().send(payload)

      // Then
      expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      expect(response.body).toHaveErrorCode("REQUESTOR_NOT_AUTHORIZED")
    })
  })

  describe("GET /quotas", () => {
    it("should list quotas", async () => {
      // Given: some quotas exist
      const now = new Date()
      await prisma.quota.create({
        data: {
          id: "00000000-0000-0000-0000-000000000101",
          scope: "Org",
          quotaType: "MAX_GROUPS",
          limit: 10,
          targetId: DEFAULT_ORG_ID,
          createdAt: now,
          updatedAt: now,
          occ: 0n
        }
      })

      // When
      const response = await get(app, "/quotas").withToken(adminToken).build().expect(HttpStatus.OK)

      // Then
      expect(response.body.data).toHaveLength(1)
      expect(response.body.data[0]).toMatchObject({
        quotaType: "MAX_GROUPS"
      })
    })

    it("should filter quotas by scope", async () => {
      // Given
      const now = new Date()
      await prisma.quota.createMany({
        data: [
          {
            id: "00000000-0000-0000-0000-000000000101",
            scope: "Org",
            quotaType: "MAX_GROUPS",
            limit: 10,
            targetId: DEFAULT_ORG_ID,
            createdAt: now,
            updatedAt: now,
            occ: 0n
          },
          {
            id: "00000000-0000-0000-0000-000000000102",
            scope: "Group",
            quotaType: "MAX_ENTITIES_PER_GROUP",
            limit: 5,
            targetId: "00000000-0000-0000-0000-000000000001",
            createdAt: now,
            updatedAt: now,
            occ: 0n
          }
        ]
      })

      // When
      const response = await get(app, "/quotas")
        .query({scope: "Group"})
        .withToken(adminToken)
        .build()
        .expect(HttpStatus.OK)

      // Then
      expect(response.body.data).toHaveLength(1)
      expect(response.body.data[0].scope).toBe("Group")
    })
  })

  describe("GET /quotas/:id", () => {
    it("should retrieve a quota by id", async () => {
      // Given
      const now = new Date()
      const quota = await prisma.quota.create({
        data: {
          id: "00000000-0000-0000-0000-000000000101",
          scope: "Org",
          quotaType: "MAX_GROUPS",
          limit: 10,
          targetId: DEFAULT_ORG_ID,
          createdAt: now,
          updatedAt: now,
          occ: 0n
        }
      })

      // When
      const response = await get(app, `/quotas/${quota.id}`).withToken(adminToken).build().expect(HttpStatus.OK)

      // Then
      expect(response.body.id).toBe(quota.id)
    })
  })

  describe("PATCH /quotas/:id", () => {
    it("should update quota limit", async () => {
      // Given
      const now = new Date()
      const quota = await prisma.quota.create({
        data: {
          id: "00000000-0000-0000-0000-000000000101",
          scope: "Org",
          quotaType: "MAX_GROUPS",
          limit: 10,
          targetId: DEFAULT_ORG_ID,
          createdAt: now,
          updatedAt: now,
          occ: 0n
        }
      })

      // When
      const payload: QuotaUpdate = {limit: 50}

      // Then
      const response = await patch(app, `/quotas/${quota.id}`)
        .withToken(adminToken)
        .build()
        .send(payload)
        .expect(HttpStatus.OK)

      expect(response.body.limit).toBe(50)
    })

    it("should allow patching with an empty body (limit should be optional)", async () => {
      // Given
      const now = new Date()
      const quota = await prisma.quota.create({
        data: {
          id: chance.guid(),
          scope: "Org",
          quotaType: "MAX_GROUPS",
          limit: 10,
          targetId: DEFAULT_ORG_ID,
          createdAt: now,
          updatedAt: now,
          occ: 0n
        }
      })

      // When: sending empty body
      const response = await patch(app, `/quotas/${quota.id}`)
        .withToken(adminToken)
        .build()
        .send({})
        .expect(HttpStatus.OK)

      // Then: limit should remain 10
      expect(response.body.limit).toBe(10)
    })
  })

  describe("DELETE /quotas/:id", () => {
    it("should delete a quota", async () => {
      // Given
      const now = new Date()
      const quota = await prisma.quota.create({
        data: {
          id: chance.guid(),
          scope: "Org",
          quotaType: "MAX_GROUPS",
          limit: 10,
          targetId: DEFAULT_ORG_ID,
          createdAt: now,
          updatedAt: now,
          occ: 0n
        }
      })

      // When
      await del(app, `/quotas/${quota.id}`).withToken(adminToken).build().expect(HttpStatus.NO_CONTENT)

      // Then
      const deleted = await prisma.quota.findUnique({where: {id: quota.id}})
      expect(deleted).toBeNull()
    })
  })
})
