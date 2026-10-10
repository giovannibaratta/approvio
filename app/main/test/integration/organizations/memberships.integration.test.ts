import {validateMembership, validateMembershipList} from "@approvio/api"
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

describe("MembershipsController", () => {
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

  it("returns a membership with its current ETag header and no body tag", async () => {
    const row = await prisma.user.findUniqueOrThrow({where: {id: owner.user.id}})
    const response = await request(app.getHttpServer())
      .get(`${endpoint}/members/${row.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
    expect(response.status).toBe(HttpStatus.OK)
    expect(validateMembership(response.body)).toBeRight()
    expect(response.body.id).toBe(row.id)
    expect(response.body).not.toHaveProperty("etag")
    expect(response.headers.etag).toBe(
      createEntityTag(configProvider.jwtConfig.secret, row.organizationId, row.id, row.occ)
    )
  })

  it("lists API memberships without per-item version tags", async () => {
    const response = await request(app.getHttpServer())
      .get(`${endpoint}/members`)
      .set("Authorization", `Bearer ${owner.token}`)
    expect(response.status).toBe(HttpStatus.OK)
    expect(validateMembershipList(response.body)).toBeRight()
    expect(response.body.items).toHaveLength(1)
    expect(response.body.items[0]).not.toHaveProperty("etag")
  })

  it("denies membership reads to ordinary members", async () => {
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: owner.user.organizationId
    })
    const response = await request(app.getHttpServer())
      .get(`${endpoint}/members/${owner.user.id}`)
      .set("Authorization", `Bearer ${member.token}`)
    expect(response.status).toBe(HttpStatus.FORBIDDEN)
  })

  it("does not return another organization's membership", async () => {
    const foreign = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
    const response = await request(app.getHttpServer())
      .get(`${endpoint}/members/${foreign.user.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
    expect(response.status).toBe(HttpStatus.NOT_FOUND)
  })

  it("rejects malformed membership identifiers", async () => {
    const response = await request(app.getHttpServer())
      .get(`${endpoint}/members/not-a-uuid`)
      .set("Authorization", `Bearer ${owner.token}`)
    expect(response.status).toBe(HttpStatus.BAD_REQUEST)
  })

  it("returns the persisted role and a new ETag after changing membership", async () => {
    // Given
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: owner.user.organizationId
    })
    const row = await prisma.user.findUniqueOrThrow({where: {id: member.user.id}})
    const detail = await request(app.getHttpServer())
      .get(`${endpoint}/members/${row.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(HttpStatus.OK)
    const etag = detail.headers.etag
    if (typeof etag !== "string") throw new Error("Membership GET must return an ETag header")

    // When
    const response = await request(app.getHttpServer())
      .patch(`${endpoint}/members/${row.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({orgRole: "admin"})

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body).toMatchObject({id: row.id, orgRole: "admin"})
    const persisted = await prisma.user.findUniqueOrThrow({where: {id: row.id}})
    expect(persisted.orgRole).toBe("admin")
    expect(persisted.occ).toBe(row.occ + 1n)
    expect(response.headers.etag).toBe(
      createEntityTag(configProvider.jwtConfig.secret, row.organizationId, row.id, persisted.occ)
    )
  })

  it("rejects a stale membership version without overwriting the persisted role", async () => {
    // Given
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: owner.user.organizationId
    })
    const row = await prisma.user.findUniqueOrThrow({where: {id: member.user.id}})
    const etag = createEntityTag(configProvider.jwtConfig.secret, row.organizationId, row.id, row.occ)
    await request(app.getHttpServer())
      .patch(`${endpoint}/members/${row.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({orgRole: "admin"})
      .expect(HttpStatus.OK)

    // When
    const response = await request(app.getHttpServer())
      .patch(`${endpoint}/members/${row.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({orgRole: "member"})

    // Expect
    expect(response.status).toBe(HttpStatus.PRECONDITION_FAILED)
    expect(response.body.code).toBe("STALE_ETAG")
    expect(await prisma.user.findUniqueOrThrow({where: {id: row.id}})).toMatchObject({
      orgRole: "admin",
      occ: row.occ + 1n
    })
  })

  it("does not expose a membership from another organization", async () => {
    // Given
    const foreign = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
    const before = await prisma.user.findUniqueOrThrow({where: {id: foreign.user.id}})
    const etag = createEntityTag(
      configProvider.jwtConfig.secret,
      owner.user.organizationId,
      foreign.user.id,
      before.occ
    )

    // When
    const response = await request(app.getHttpServer())
      .patch(`${endpoint}/members/${foreign.user.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({orgRole: "admin"})

    // Expect
    expect(response.status).toBe(HttpStatus.NOT_FOUND)
    expect(response.body.code).toBe("MEMBERSHIP_NOT_FOUND")
    expect(await prisma.user.findUniqueOrThrow({where: {id: foreign.user.id}})).toMatchObject({
      orgRole: "member",
      occ: before.occ
    })
  })
})
