import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {createAuthenticatedUserInDb, TestTokenBuilder} from "@test/token-helpers"
import {UserWithToken} from "@test/types"
import request from "supertest"
import {v7 as uuidv7} from "uuid"

describe("OrganizationController", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let owner: UserWithToken
  let endpoint: string

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()
    const module = await Test.createTestingModule({imports: [AppModule]})
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb))
      .compile()

    app = module.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(isolatedDb)
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
    await prisma.$disconnect()
    await app.close()
  })

  const getCurrentETag = async (): Promise<string> => {
    const response = await request(app.getHttpServer())
      .get(endpoint)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(HttpStatus.OK)
    const etag = response.headers.etag
    if (typeof etag !== "string") throw new Error("Organization summary omitted its ETag")
    return etag
  }

  it("returns the owner's organization summary with an ETag", async () => {
    // Given
    const organizationId = owner.user.organizationId

    // When
    const response = await request(app.getHttpServer()).get(endpoint).set("Authorization", `Bearer ${owner.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body).toMatchObject({id: organizationId, status: "active"})
    expect(response.headers.etag).toEqual(expect.any(String))
  })

  it("allows an owner to update their organization with a current ETag", async () => {
    // Given
    const etag = await getCurrentETag()

    // When
    const response = await request(app.getHttpServer())
      .patch(endpoint)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({displayName: "Renamed organization"})

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body.displayName).toBe("Renamed organization")
    expect(response.headers.etag).toEqual(expect.any(String))
    expect(response.headers.etag).not.toBe(etag)
  })

  it("allows an owner to suspend their organization with a current ETag", async () => {
    // Given
    const etag = await getCurrentETag()

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/suspend`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body.status).toBe("suspended")
    expect(response.headers.etag).toEqual(expect.any(String))
    expect(response.headers.etag).not.toBe(etag)
  })

  it("allows an owner to resume their organization with a current ETag", async () => {
    // Given
    await prisma.organization.update({
      where: {id: owner.user.organizationId},
      data: {status: "suspended", suspensionReason: "owner_requested"}
    })
    const etag = await getCurrentETag()

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/resume`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body.status).toBe("active")
    expect(response.headers.etag).toEqual(expect.any(String))
    expect(response.headers.etag).not.toBe(etag)
  })

  it("allows an owner to request deletion with a current ETag and a bound step-up receipt", async () => {
    // Given
    const etag = await getCurrentETag()
    const session = await prisma.browserSession.findFirstOrThrow({
      where: {accountId: owner.user.accountId, selectedOrganizationId: owner.user.organizationId}
    })
    const jti = uuidv7()
    await prisma.stepUpReceipt.create({
      data: {
        id: uuidv7(),
        organizationId: owner.user.organizationId,
        jti,
        userId: owner.user.id,
        sessionId: session.id,
        providerId: session.providerId,
        contextVersion: session.contextVersion,
        operation: "delete_organization",
        resourceId: owner.user.organizationId,
        expiresAt: new Date(Date.now() + 60000),
        createdAt: new Date()
      }
    })
    const token = TestTokenBuilder.signUserToken(jwtService, configProvider, owner.user, {
      sessionId: session.id,
      providerId: session.providerId,
      contextVersion: session.contextVersion,
      stepUpContext: {jti, operation: "delete_organization", resource: owner.user.organizationId}
    })

    // When
    const response = await request(app.getHttpServer())
      .delete(endpoint)
      .set("Authorization", `Bearer ${token}`)
      .set("If-Match", etag)

    // Expect
    expect(response.status).toBe(HttpStatus.ACCEPTED)
    expect(response.body.status).toBe("deleting")
    expect(response.headers.etag).toEqual(expect.any(String))
    expect(response.headers.etag).not.toBe(etag)

    const receipt = await prisma.stepUpReceipt.findUniqueOrThrow({
      where: {organizationId_jti: {organizationId: owner.user.organizationId, jti}}
    })
    expect(receipt.consumedAt).toBeInstanceOf(Date)
    const organization = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})
    expect(organization.status).toBe("deleting")
  })

  it("rejects deletion by an owner without step-up authentication", async () => {
    // Given
    const etag = await getCurrentETag()

    // When
    const response = await request(app.getHttpServer())
      .delete(endpoint)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)

    // Expect
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED)
    expect(response.body.code).toBe("STEP_UP_CONTEXT_MISSING")
    const organization = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})
    expect(organization.status).toBe("active")
  })

  it.each(["member", "admin"] as const)("rejects update by a non-owner %s", async orgRole => {
    // Given
    const nonOwner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: owner.user.organizationId,
      orgRole
    })
    const etag = await getCurrentETag()
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})

    // When
    const response = await request(app.getHttpServer())
      .patch(endpoint)
      .set("Authorization", `Bearer ${nonOwner.token}`)
      .set("If-Match", etag)
      .send({displayName: "Forbidden rename"})

    // Expect
    expect(response.status).toBe(HttpStatus.FORBIDDEN)
    expect(response.body.code).toBe("PERMISSION_DENIED")
    const after = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})
    expect(after).toEqual(before)
    expect(await prisma.auditLog.count({where: {organizationId: owner.user.organizationId}})).toBe(0)
  })

  it.each(["member", "admin"] as const)("rejects suspend by a non-owner %s", async orgRole => {
    // Given
    const nonOwner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: owner.user.organizationId,
      orgRole
    })
    const etag = await getCurrentETag()
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/suspend`)
      .set("Authorization", `Bearer ${nonOwner.token}`)
      .set("If-Match", etag)

    // Expect
    expect(response.status).toBe(HttpStatus.FORBIDDEN)
    expect(response.body.code).toBe("PERMISSION_DENIED")
    const after = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})
    expect(after).toEqual(before)
    expect(await prisma.auditLog.count({where: {organizationId: owner.user.organizationId}})).toBe(0)
  })

  it.each(["member", "admin"] as const)("rejects resume by a non-owner %s", async orgRole => {
    // Given
    const nonOwner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: owner.user.organizationId,
      orgRole
    })
    const etag = await getCurrentETag()
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/resume`)
      .set("Authorization", `Bearer ${nonOwner.token}`)
      .set("If-Match", etag)

    // Expect
    expect(response.status).toBe(HttpStatus.FORBIDDEN)
    expect(response.body.code).toBe("PERMISSION_DENIED")
    const after = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})
    expect(after).toEqual(before)
    expect(await prisma.auditLog.count({where: {organizationId: owner.user.organizationId}})).toBe(0)
  })

  it.each(["member", "admin"] as const)("rejects delete by a non-owner %s", async orgRole => {
    // Given
    const nonOwner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: owner.user.organizationId,
      orgRole
    })
    const etag = await getCurrentETag()
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})

    // When
    const response = await request(app.getHttpServer())
      .delete(endpoint)
      .set("Authorization", `Bearer ${nonOwner.token}`)
      .set("If-Match", etag)

    // Expect
    expect(response.status).toBe(HttpStatus.FORBIDDEN)
    expect(response.body.code).toBe("PERMISSION_DENIED")
    const after = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})
    expect(after).toEqual(before)
    expect(await prisma.auditLog.count({where: {organizationId: owner.user.organizationId}})).toBe(0)
  })
})
