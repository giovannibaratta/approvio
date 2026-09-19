import {AUDIT_LOG_REPOSITORY_TOKEN, AuditLogRepository} from "@services/audit-log/interfaces"
import * as TE from "fp-ts/TaskEither"
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
import {MockConfigProvider, createMockAgentInDb} from "@test/mock-data"
import {mapAgentToDomain} from "@external/database/shared"
import {unwrapRight} from "@utils/either"
import {createAuthenticatedUserInDb, TestTokenBuilder} from "@test/token-helpers"
import {UserWithToken} from "@test/types"
import request from "supertest"
import {v7 as uuidv7} from "uuid"

describe("OrganizationController", () => {
  let isolatedDb: string
  let redisPrefix: string
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let owner: UserWithToken
  let endpoint: string

  beforeAll(async () => {
    isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()
    const module = await Test.createTestingModule({imports: [AppModule]})
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb, redisPrefix))
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
    await app.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(isolatedDb)
    await cleanRedisByPrefix(redisPrefix)
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

  it("returns an internal server error when a stored organization summary is invalid", async () => {
    // Given
    await prisma.organization.update({where: {id: owner.user.organizationId}, data: {displayName: "   "}})

    // When
    const response = await request(app.getHttpServer()).get(endpoint).set("Authorization", `Bearer ${owner.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
    expect(response.body.code).toBe("UNKNOWN_ERROR")
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

  it("rejects renaming a suspended organization without changing persisted state", async () => {
    // Given
    await prisma.organization.update({
      where: {id: owner.user.organizationId},
      data: {status: "suspended", suspensionReason: "owner_requested"}
    })
    const etag = await getCurrentETag()
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})

    // When
    const response = await request(app.getHttpServer())
      .patch(endpoint)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({displayName: "Renamed organization"})

    // Expect
    expect(response.status).toBe(HttpStatus.LOCKED)
    expect(response.body.code).toBe("ORGANIZATION_SUSPENDED")
    expect(await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})).toEqual(before)
    expect(await prisma.auditLog.count({where: {organizationId: owner.user.organizationId}})).toBe(0)
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

  it("rejects active to active without changing persisted state", async () => {
    // Given
    await prisma.organization.update({
      where: {id: owner.user.organizationId},
      data: {status: "active", suspensionReason: null}
    })
    const etag = await getCurrentETag()
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/resume`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)

    // Expect
    expect(response.status).toBe(HttpStatus.CONFLICT)
    expect(response.body.code).toBe("ORGANIZATION_INVALID_TRANSITION")
    expect(await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})).toEqual(before)
  })

  it("rejects suspending an already suspended organization without changing persisted state", async () => {
    // Given
    const etag = await getCurrentETag()
    await prisma.organization.update({
      where: {id: owner.user.organizationId},
      data: {status: "suspended", suspensionReason: "owner_requested"}
    })
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/suspend`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)

    // Expect
    expect(response.status).toBe(HttpStatus.LOCKED)
    expect(response.body.code).toBe("ORGANIZATION_SUSPENDED")
    expect(await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})).toEqual(before)
  })

  it("returns an internal server error for a malformed stored step-up receipt without changing persisted state", async () => {
    // Given
    const etag = await getCurrentETag()
    const context = {organizationId: owner.user.organizationId}
    const session = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    const jti = uuidv7()
    await prisma.stepUpReceipt.create({
      data: {
        id: uuidv7(),
        organizationId: context.organizationId,
        jti,
        userId: owner.user.id,
        sessionId: session.id,
        providerId: session.providerId,
        contextVersion: session.contextVersion,
        operation: "invalid_operation",
        resourceId: context.organizationId,
        expiresAt: new Date(Date.now() + 60000),
        createdAt: new Date()
      }
    })
    const token = TestTokenBuilder.signUserToken(jwtService, configProvider, owner.user, {
      sessionId: session.id,
      providerId: session.providerId,
      contextVersion: session.contextVersion,
      stepUpContext: {jti, operation: "delete_organization", resource: context.organizationId}
    })
    const before = await prisma.organization.findUniqueOrThrow({where: {id: context.organizationId}})

    // When
    const response = await request(app.getHttpServer())
      .delete(endpoint)
      .set("Authorization", `Bearer ${token}`)
      .set("If-Match", etag)

    // Expect
    expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
    expect(response.body.code).toBe("UNKNOWN_ERROR")
    expect(await prisma.organization.findUniqueOrThrow({where: {id: context.organizationId}})).toEqual(before)
    const receipt = await prisma.stepUpReceipt.findUniqueOrThrow({
      where: {organizationId_jti: {organizationId: context.organizationId, jti}}
    })
    expect(receipt.consumedAt).toBeNull()
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

  it("normalizes the updated display name and persists its audit in the same transaction", async () => {
    // Given
    const etag = await getCurrentETag()

    // When
    const response = await request(app.getHttpServer())
      .patch(endpoint)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({displayName: "  Updated  "})

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body.displayName).toBe("Updated")
    expect(await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})).toMatchObject({
      displayName: "Updated",
      occ: 1n
    })
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {organizationId: owner.user.organizationId, auditType: "ORGANIZATION_UPDATED"}
    })
    expect(audit.payload).toMatchObject({displayName: "Updated"})
  })

  it("rejects an empty display name without changing metadata or creating an audit", async () => {
    // Given: The owner has a current organization ETag.
    const etag = await getCurrentETag()
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})

    // When: Update the organization with a name containing only whitespace.
    const response = await request(app.getHttpServer())
      .patch(endpoint)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({displayName: "   "})

    // Expect: Domain validation rejects the name before persistence or audit creation.
    expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    // TODO: This error code is wrong, validate we are not collpasing or doing a wrong mapping.
    expect(response.body).toHaveErrorCode("INVALID_ORGANIZATION")
    expect(await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})).toEqual(before)
    expect(await prisma.auditLog.count({where: {organizationId: owner.user.organizationId}})).toBe(0)
  })

  it("rejects an oversized display name without changing metadata or creating an audit", async () => {
    // Given: The owner has a current organization ETag.
    const etag = await getCurrentETag()
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})

    // When: Update the organization with a name exceeding the 255-character domain limit.
    const response = await request(app.getHttpServer())
      .patch(endpoint)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({displayName: "a".repeat(256)})

    // Expect: Domain validation rejects the name before persistence or audit creation.
    expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    // TODO: This error code is wrong, validate we are not collpasing or doing a wrong mapping.
    expect(response.body).toHaveErrorCode("INVALID_ORGANIZATION")
    expect(await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})).toEqual(before)
    expect(await prisma.auditLog.count({where: {organizationId: owner.user.organizationId}})).toBe(0)
  })

  it("rejects a stale update ETag without changing metadata or creating another audit", async () => {
    // Given
    const etag = await getCurrentETag()
    await request(app.getHttpServer())
      .patch(endpoint)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({displayName: "First update"})
      .expect(HttpStatus.OK)

    // When
    const response = await request(app.getHttpServer())
      .patch(endpoint)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({displayName: "Stale update"})

    // Expect
    expect(response.status).toBe(HttpStatus.PRECONDITION_FAILED)
    expect(response.body.code).toBe("STALE_ETAG")
    expect(await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})).toMatchObject({
      displayName: "First update",
      occ: 1n
    })
    expect(
      await prisma.auditLog.count({
        where: {organizationId: owner.user.organizationId, auditType: "ORGANIZATION_UPDATED"}
      })
    ).toBe(1)
  })

  it("rolls back metadata and its version when audit persistence fails", async () => {
    // Given
    const etag = await getCurrentETag()
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})
    const audit = app.get<AuditLogRepository>(AUDIT_LOG_REPOSITORY_TOKEN)
    const failure = jest.spyOn(audit, "persist").mockReturnValueOnce(TE.left("unknown_error"))

    // TODO: Drop try/catch and use before/after hooks.
    try {
      // When
      const response = await request(app.getHttpServer())
        .patch(endpoint)
        .set("Authorization", `Bearer ${owner.token}`)
        .set("If-Match", etag)
        .send({displayName: "Rolled back"})

      // Expect
      expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
      expect(await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})).toEqual(before)
      expect(await prisma.auditLog.count({where: {organizationId: owner.user.organizationId}})).toBe(0)
    } finally {
      failure.mockRestore()
    }
  })

  it("rejects an update retargeted to another organization", async () => {
    // Given
    const other = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})

    // When
    const response = await request(app.getHttpServer())
      .patch(`/o/${other.user.organizationId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({displayName: "Foreign update"})

    // Expect
    expect(response.status).toBe(HttpStatus.FORBIDDEN)
    expect(response.body.code).toBe("ORGANIZATION_MISMATCH")
  })

  it.each([
    {status: "deleting", code: "RESOURCE_NOT_FOUND"},
    {status: "deleted", code: "RESOURCE_NOT_FOUND"}
  ])("rejects organization operations after the organization is $status", async ({status, code}) => {
    // Given
    await prisma.organization.update({where: {id: owner.user.organizationId}, data: {status}})

    // When
    const response = await request(app.getHttpServer()).get(endpoint).set("Authorization", `Bearer ${owner.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.NOT_FOUND)
    expect(response.body.code).toBe(code)
  })

  it.each([
    {role: "owner", status: HttpStatus.OK},
    {role: "admin", status: HttpStatus.OK},
    {role: "member", status: HttpStatus.LOCKED}
  ] as const)("checks $role access to a suspended organization's summary", async ({role, status}) => {
    // Given
    const user = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: owner.user.organizationId,
      orgRole: role
    })
    await prisma.organization.update({where: {id: owner.user.organizationId}, data: {status: "suspended"}})

    // When
    const response = await request(app.getHttpServer()).get(endpoint).set("Authorization", `Bearer ${user.token}`)

    // Expect
    expect(response.status).toBe(status)
    // TODO: What is this ? Why do we have two different paths ? Is this for owner/admin vs member ? If yes, split in two tests. I don't like the conditional.
    expect(response.body).toMatchObject(
      status === HttpStatus.OK ? {status: "suspended"} : {code: "ORGANIZATION_SUSPENDED"}
    )
  })

  it("rejects an agent's management summary access while its organization is suspended", async () => {
    // Given: An active agent belongs to an organization that has been suspended.
    const agent = await createMockAgentInDb(prisma, {organizationId: owner.user.organizationId})
    const token = TestTokenBuilder.signAgentToken(jwtService, configProvider, unwrapRight(mapAgentToDomain(agent)))
    await prisma.organization.update({where: {id: owner.user.organizationId}, data: {status: "suspended"}})

    // When: The agent requests its organization's management summary.
    const response = await request(app.getHttpServer()).get(endpoint).set("Authorization", `Bearer ${token}`)

    // Expect: Organization admission denies access despite the valid agent identity.
    expect(response).toHaveStatusCode(HttpStatus.LOCKED)
    expect(response.body).toHaveErrorCode("ORGANIZATION_SUSPENDED")
  })

  it.each(["owner", "admin", "member"] as const)(
    "blocks routine tenant operations by a %s while suspended",
    async role => {
      // Given
      const user = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
        organizationId: owner.user.organizationId,
        orgRole: role
      })
      await prisma.organization.update({where: {id: owner.user.organizationId}, data: {status: "suspended"}})

      // When
      const response = await request(app.getHttpServer())
        .get(`${endpoint}/members`)
        .set("Authorization", `Bearer ${user.token}`)

      // Expect
      expect(response.status).toBe(HttpStatus.LOCKED)
      expect(response.body.code).toBe("ORGANIZATION_SUSPENDED")
    }
  )

  it.each([
    {role: "admin", operation: "resume"},
    {role: "member", operation: "resume"},
    {role: "admin", operation: "delete"},
    {role: "member", operation: "delete"}
  ] as const)("blocks $role admission for $operation while suspended", async ({role, operation}) => {
    // Given
    const user = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: owner.user.organizationId,
      orgRole: role
    })
    await prisma.organization.update({where: {id: owner.user.organizationId}, data: {status: "suspended"}})
    // TODO: Split in two differnt tetsts
    const mutation =
      operation === "delete"
        ? request(app.getHttpServer()).delete(endpoint)
        : request(app.getHttpServer()).post(`${endpoint}/resume`)

    // When
    const response = await mutation.set("Authorization", `Bearer ${user.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.LOCKED)
    expect(response.body.code).toBe("ORGANIZATION_SUSPENDED")
    expect(await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})).toMatchObject({
      status: "suspended"
    })
  })

  it.each(["FREE", "SELF_HOSTED_UNLIMITED"] as const)(
    "returns the requested organization's %s plan tier",
    async planTier => {
      // Given
      const other = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
      await prisma.organization.update({where: {id: owner.user.organizationId}, data: {planTier}})
      // TODO: I don't like this. It is coupled with the implementaiton logic. Either we go via an API, so we know the value will be set correctly or we just drop the test.
      await prisma.organization.update({
        where: {id: other.user.organizationId},
        data: {
          planTier: planTier === "FREE" ? "SELF_HOSTED_UNLIMITED" : "FREE"
        }
      })

      // When
      const response = await request(app.getHttpServer())
        .get(`${endpoint}/entitlements`)
        .set("Authorization", `Bearer ${owner.token}`)

      // Expect
      expect(response.status).toBe(HttpStatus.OK)
      expect(response.body).toMatchObject({organizationId: owner.user.organizationId, planTier})
    }
  )
})
