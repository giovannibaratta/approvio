import {createEntityTag} from "@controllers/etag"
import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  dropPreparedDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import {UserWithToken} from "@test/types"
import request from "supertest"

describe("Organization audit snapshots", () => {
  let connection: string
  let redisPrefix: string
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let owner: UserWithToken
  let endpoint: string

  beforeAll(async () => {
    connection = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()
    const module = await Test.createTestingModule({imports: [AppModule]})
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromTenantConnectionUrl(connection, redisPrefix))
      .compile()

    app = module.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(connection)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)
    await app.init()
  }, 30000)

  beforeEach(async () => {
    owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
    endpoint = `/o/${owner.user.organizationId}`
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
    await cleanRedisByPrefix(redisPrefix)
  })

  it("retains the original actor attribution after membership removal", async () => {
    // Given
    const auditor = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: owner.user.organizationId,
      orgRole: "admin"
    })
    const original = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})
    await request(app.getHttpServer())
      .patch(endpoint)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", createEntityTag(configProvider.jwtConfig.secret, original.id, original.id, original.occ))
      .send({displayName: "Audited organization"})
      .expect(HttpStatus.OK)
    await prisma.user.update({
      where: {id: owner.user.id},
      data: {status: "removed", displayName: "Changed after audit"}
    })

    // When
    const response = await request(app.getHttpServer())
      .get(`${endpoint}/audit-logs`)
      .set("Authorization", `Bearer ${auditor.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body.auditLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: {type: "ORGANIZATION", id: owner.user.organizationId},
          actor: expect.objectContaining({id: owner.user.id, type: "user", displayName: owner.user.displayName})
        })
      ])
    )
  })
  it("does not expose audit snapshots to another organization", async () => {
    // Given
    const original = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})
    await request(app.getHttpServer())
      .patch(endpoint)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", createEntityTag(configProvider.jwtConfig.secret, original.id, original.id, original.occ))
      .send({displayName: "Private audit"})
      .expect(HttpStatus.OK)
    const other = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "admin"})

    // When
    const response = await request(app.getHttpServer())
      .get(`/o/${other.user.organizationId}/audit-logs`)
      .set("Authorization", `Bearer ${other.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body.auditLogs).toEqual([])
    expect(await prisma.auditLog.count({where: {organizationId: owner.user.organizationId}})).toBe(1)
  })
})
