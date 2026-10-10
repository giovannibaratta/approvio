import {createPlatformSessionInDb} from "@test/platform-session"
import {v7 as uuidv7} from "uuid"
import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {AuditLogRepository, AUDIT_LOG_REPOSITORY_TOKEN} from "@services"
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
import request from "supertest"

jest.setTimeout(15000)

describe("AccountOrganizationsController", () => {
  let connection: string
  let redisPrefix: string
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let session: Awaited<ReturnType<typeof createPlatformSessionInDb>>

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
    session = await createPlatformSessionInDb(prisma, jwtService, configProvider)
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

  it("lists only this account's active memberships and excludes removed memberships", async () => {
    // Given
    const first = await createOrganization("first")
    const second = await createOrganization("second")
    const removed = await createOrganization("removed")
    const foreign = await createOrganization("foreign")
    const other = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    await Promise.all([
      createMembership(session.account.id, first),
      createMembership(session.account.id, second),
      createMembership(session.account.id, removed, "removed"),
      createMembership(other.account.id, foreign)
    ])

    // When
    const response = await request(app.getHttpServer())
      .get("/organizations")
      .set("Authorization", `Bearer ${session.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body.items.map((item: {id: string}) => item.id).sort()).toEqual([first, second].sort())
    expect(response.body.total).toBe(2)
  })

  it("returns an empty discovery result for an account without memberships", async () => {
    // Given
    const token = session.token

    // When
    const response = await request(app.getHttpServer()).get("/organizations").set("Authorization", `Bearer ${token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body).toMatchObject({items: [], total: 0, page: 1, limit: 20})
  })

  it("creates a normalized organization and exactly one local owner", async () => {
    // Given
    const slug = `created-${uuidv7()}`

    // When
    const response = await request(app.getHttpServer())
      .post("/organizations")
      .set("Authorization", `Bearer ${session.token}`)
      .send({slug, displayName: "  Example Organization  "})

    // Expect
    expect(response.status).toBe(HttpStatus.CREATED)
    expect(response.body.organization).toMatchObject({slug, displayName: "Example Organization", status: "active"})
    const organization = await prisma.organization.findUniqueOrThrow({where: {slug}, include: {users: true}})
    expect(organization.planTier).toBe(
      configProvider.deploymentEdition === "self_hosted" ? "SELF_HOSTED_UNLIMITED" : "FREE"
    )
    expect(organization.users).toHaveLength(1)
    expect(organization.users[0]).toMatchObject({
      id: response.body.owner.id,
      platformAccountId: session.account.id,
      orgRole: "owner",
      status: "active"
    })
    expect(await prisma.auditLog.findMany({where: {organizationId: organization.id}})).toEqual([
      expect.objectContaining({
        auditType: "ORGANIZATION_CREATED",
        entityId: organization.id,
        actorId: response.body.owner.id
      })
    ])
  })

  it("rolls back the organization and owner when creation audit persistence fails", async () => {
    // Given
    const slug = `rollback-${uuidv7()}`
    const audit = app.get<AuditLogRepository>(AUDIT_LOG_REPOSITORY_TOKEN)
    const auditFailure = jest.spyOn(audit, "persist").mockReturnValueOnce(TE.left("unknown_error"))

    try {
      // When
      const response = await request(app.getHttpServer())
        .post("/organizations")
        .set("Authorization", `Bearer ${session.token}`)
        .send({slug, displayName: "Rolled back organization"})

      // Expect
      expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
      expect(auditFailure).toHaveBeenCalledTimes(1)
      expect(await prisma.organization.count({where: {slug}})).toBe(0)
      expect(await prisma.user.count({where: {platformAccountId: session.account.id}})).toBe(0)
      expect(await prisma.auditLog.count()).toBe(0)
    } finally {
      auditFailure.mockRestore()
    }
  })

  it("creates only one organization and owner when identical slugs race", async () => {
    // Given
    const slug = `concurrent-${uuidv7()}`
    const create = () =>
      request(app.getHttpServer())
        .post("/organizations")
        .set("Authorization", `Bearer ${session.token}`)
        .send({slug, displayName: "Concurrent organization"})

    // When
    const responses = await Promise.all([create(), create()])

    // Expect
    expect(responses.map(response => response.status).sort()).toEqual([HttpStatus.CREATED, HttpStatus.CONFLICT])
    expect(responses.find(response => response.status === Number(HttpStatus.CONFLICT))?.body.code).toBe(
      "ORGANIZATION_ALREADY_EXISTS"
    )
    const organizations = await prisma.organization.findMany({where: {slug}, include: {users: true}})
    expect(organizations).toHaveLength(1)
    expect(organizations[0]?.users).toHaveLength(1)
    expect(organizations[0]?.users[0]).toMatchObject({
      platformAccountId: session.account.id,
      status: "active",
      orgRole: "owner"
    })
  })

  it("rejects invalid organization details before provisioning", async () => {
    // Given
    const before = await prisma.organization.count()

    // When
    const response = await request(app.getHttpServer())
      .post("/organizations")
      .set("Authorization", `Bearer ${session.token}`)
      .send({slug: "Invalid Slug", displayName: "Example"})

    // Expect
    expect(response.status).toBe(HttpStatus.BAD_REQUEST)
    expect(response.body.code).toBe("INVALID_ORGANIZATION")
    expect(await prisma.organization.count()).toBe(before)
  })

  it.each(["page=0", "page=1.5", "limit=0", "limit=101"])("rejects invalid pagination: %s", async query => {
    // Given
    const url = `/organizations?${query}`

    // When
    const response = await request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${session.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.BAD_REQUEST)
    expect(response.body.code).toBe("INVALID_PAGINATION")
  })

  it("rejects a disabled account before discovering organizations", async () => {
    // Given
    await prisma.platformAccount.update({where: {id: session.account.id}, data: {status: "disabled"}})

    // When
    const response = await request(app.getHttpServer())
      .get("/organizations")
      .set("Authorization", `Bearer ${session.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.FORBIDDEN)
    expect(response.body.code).toBe("PERMISSION_DENIED")
  })

  it("rejects organization creation by a disabled account without provisioning rows", async () => {
    // Given
    await prisma.platformAccount.update({where: {id: session.account.id}, data: {status: "disabled"}})
    const before = await prisma.organization.count()

    // When
    const response = await request(app.getHttpServer())
      .post("/organizations")
      .set("Authorization", `Bearer ${session.token}`)
      .send({slug: `disabled-${session.account.id}`, displayName: "Denied"})

    // Expect
    expect(response.status).toBe(HttpStatus.FORBIDDEN)
    expect(response.body.code).toBe("PERMISSION_DENIED")
    expect(await prisma.organization.count()).toBe(before)
    expect(await prisma.user.count({where: {platformAccountId: session.account.id}})).toBe(0)
  })

  async function createOrganization(label: string) {
    const id = uuidv7()
    const now = new Date()
    await prisma.organization.create({
      data: {
        id,
        slug: `${label}-${id}`,
        displayName: label,
        planTier: "FREE",
        status: "active",
        occ: 0n,
        createdAt: now,
        updatedAt: now
      }
    })
    return id
  }

  async function createMembership(accountId: string, organizationId: string, status = "active") {
    const now = new Date()
    await prisma.user.create({
      data: {
        id: uuidv7(),
        organizationId,
        platformAccountId: accountId,
        displayName: "Local member",
        status,
        orgRole: "member",
        roles: [],
        createdAt: now,
        updatedAt: now,
        occ: 0n
      }
    })
  }
})
