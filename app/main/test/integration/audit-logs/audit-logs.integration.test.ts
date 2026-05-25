import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {AUDIT_LOGS_ENDPOINT_ROOT} from "../../../../controllers/src/audit-logs/audit-logs.controller"
import {PrismaClient} from "@prisma/client"

import {cleanDatabase, prepareDatabase} from "@test/database"
import {createDomainMockUserInDb, MockConfigProvider} from "@test/mock-data"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {get} from "@test/requests"
import {UserWithToken} from "@test/types"
import {TokenPayloadBuilder} from "@services"
import {v7 as uuidv7} from "uuid"

describe("Audit Logs API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider

  const endpoint = `/${AUDIT_LOGS_ENDPOINT_ROOT}`

  beforeAll(async () => {
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

    app = module.createNestApplication({logger: ["error", "warn", "log"]})
    prisma = module.get(DatabaseClient).prisma
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)

    await app.init()
  })

  beforeEach(async () => {
    await cleanDatabase(prisma)

    const domainMemberUser = await createDomainMockUserInDb(prisma, {orgAdmin: false})
    const domainAdminUser = await createDomainMockUserInDb(prisma, {orgAdmin: true})

    orgMemberUser = {
      user: domainMemberUser,
      token: await jwtService.signAsync(
        TokenPayloadBuilder.fromUser(domainMemberUser, {
          issuer: configProvider.jwtConfig.issuer,
          audience: [configProvider.jwtConfig.audience]
        }),
        {
          secret: configProvider.jwtConfig.secret
        }
      )
    }

    orgAdminUser = {
      user: domainAdminUser,
      token: await jwtService.signAsync(
        TokenPayloadBuilder.fromUser(domainAdminUser, {
          issuer: configProvider.jwtConfig.issuer,
          audience: [configProvider.jwtConfig.audience]
        }),
        {
          secret: configProvider.jwtConfig.secret
        }
      )
    }

    // Insert mock audit logs
    await prisma.auditLog.createMany({
      data: [
        {
          id: uuidv7(),
          auditType: "SPACE_CREATED",
          entityType: "SPACE",
          entityId: uuidv7(),
          actorId: orgAdminUser.user.id,
          actorType: "user",
          payload: {name: "Space 1"},
          createdAt: new Date()
        },
        {
          id: uuidv7(),
          auditType: "GROUP_CREATED",
          entityType: "GROUP",
          entityId: uuidv7(),
          actorId: orgMemberUser.user.id,
          actorType: "user",
          payload: {name: "Group 1"},
          createdAt: new Date()
        },
        {
          id: uuidv7(),
          auditType: "SPACE_CREATED",
          entityType: "SPACE",
          entityId: uuidv7(),
          actorId: orgAdminUser.user.id,
          actorType: "user",
          payload: {name: "Space Old"},
          createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) // 8 days old (should be filtered out)
        }
      ]
    })
  })

  afterAll(async () => {
    await app.close()
  })

  describe("GET /audit-logs", () => {
    it("should return 403 Forbidden for non-admin user", async () => {
      // Given
      const nonAdminToken = orgMemberUser.token

      // When
      const response = await get(app, endpoint).withToken(nonAdminToken).build()

      // Expect
      expect(response.status).toBe(HttpStatus.FORBIDDEN)
    })

    it("should return 200 OK for admin user and return keyset paginated audit logs (filtering out >7 days old)", async () => {
      // Given
      const adminToken = orgAdminUser.token

      // When
      const response = await get(app, endpoint).withToken(adminToken).build()

      // Expect
      expect(response.status).toBe(HttpStatus.OK)
      expect(response.body).toHaveProperty("auditLogs")
      expect(response.body).toHaveProperty("pagination")
      // Only the 2 logs from today should be returned. The 8-day old log should be pruned.
      expect(response.body.auditLogs).toHaveLength(2)
      expect(response.body.pagination.hasMore).toBe(false)
      expect(response.body.pagination.nextCursor).toBeUndefined()
    })

    it("should filter audit logs by actorId", async () => {
      // Given
      const adminToken = orgAdminUser.token
      const memberUserId = orgMemberUser.user.id

      // When
      const response = await get(app, `${endpoint}?actors=user:${memberUserId}`).withToken(adminToken).build()

      // Expect
      expect(response.status).toBe(HttpStatus.OK)
      expect(response.body.auditLogs).toHaveLength(1)
      expect(response.body.auditLogs[0].actor.id).toBe(memberUserId)
      expect(response.body.pagination.hasMore).toBe(false)
    })

    it("should handle multiple values for array filters gracefully", async () => {
      // Given
      const adminToken = orgAdminUser.token
      const memberUserId = orgMemberUser.user.id
      const adminUserId = orgAdminUser.user.id

      // When: We send multiple query parameter values for the same array filter
      const response = await get(app, `${endpoint}?actors=user:${memberUserId}&actors=user:${adminUserId}`)
        .withToken(adminToken)
        .build()

      // Expect: Both logs are returned successfully, confirming multiple filters are parsed as an array and handled properly
      expect(response.status).toBe(HttpStatus.OK)
      expect(response.body.auditLogs).toHaveLength(2)
      const actorIds = response.body.auditLogs.map((log: {actor: {id: string}}) => log.actor.id)
      expect(actorIds).toContain(memberUserId)
      expect(actorIds).toContain(adminUserId)
    })

    it("should paginate correctly using keyset cursor", async () => {
      // Given
      const adminToken = orgAdminUser.token

      // When: First page with limit = 1
      const response1 = await get(app, `${endpoint}?limit=1`).withToken(adminToken).build()

      // Expect
      expect(response1.status).toBe(HttpStatus.OK)
      expect(response1.body.auditLogs).toHaveLength(1)
      expect(response1.body.pagination.hasMore).toBe(true)
      expect(response1.body.pagination.nextCursor).not.toBeNull()

      const firstLogId = response1.body.auditLogs[0].id
      const cursor = response1.body.pagination.nextCursor

      // When: Second page using nextCursor
      const response2 = await get(app, `${endpoint}?limit=1&cursor=${cursor}`).withToken(adminToken).build()

      // Expect
      expect(response2.status).toBe(HttpStatus.OK)
      expect(response2.body.auditLogs).toHaveLength(1)
      expect(response2.body.pagination.hasMore).toBe(false)
      expect(response2.body.pagination.nextCursor).toBeUndefined()
      expect(response2.body.auditLogs[0].id).not.toBe(firstLogId)
    })

    it("should return 200 OK and empty list when no audit logs match filters", async () => {
      // Given
      const adminToken = orgAdminUser.token

      // When
      const response = await get(app, `${endpoint}?actors=user:00000000-0000-0000-0000-000000000000`)
        .withToken(adminToken)
        .build()

      // Expect
      expect(response.status).toBe(HttpStatus.OK)
      expect(response.body.auditLogs).toHaveLength(0)
      expect(response.body.pagination.hasMore).toBe(false)
      expect(response.body.pagination.nextCursor).toBeUndefined()
    })
  })

  describe("GET /audit-logs/me", () => {
    it("should return 200 OK for any user and enforce requestor.id filter", async () => {
      // Given
      const memberToken = orgMemberUser.token
      const memberUserId = orgMemberUser.user.id

      // When
      const response = await get(app, `${endpoint}/me`).withToken(memberToken).build()

      // Expect
      expect(response.status).toBe(HttpStatus.OK)
      expect(response.body).toHaveProperty("auditLogs")
      expect(response.body).toHaveProperty("pagination")
      expect(response.body.auditLogs).toHaveLength(1)
      expect(response.body.auditLogs[0].actor.id).toBe(memberUserId)
      expect(response.body.pagination.hasMore).toBe(false)
    })
  })
})
