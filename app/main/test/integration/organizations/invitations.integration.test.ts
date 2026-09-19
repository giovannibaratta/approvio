import {SystemRole} from "@domain"
import {createPlatformSessionInDb} from "@test/platform-session"
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

describe("InvitationsController", () => {
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
    jest.restoreAllMocks()
    await cleanDatabase(prisma)
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
    await cleanRedisByPrefix(redisPrefix)
  })

  async function createPendingInvitation() {
    const invitee = await createPlatformSessionInDb(prisma, jwtService, configProvider)

    const created = await request(app.getHttpServer())
      .post(`${endpoint}/invitations`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "member"})
      .expect(HttpStatus.CREATED)

    const accept = (organizationId = owner.user.organizationId) =>
      request(app.getHttpServer())
        .post(`/o/${organizationId}/invitations/${created.body.id}/accept`)
        .set("Authorization", `Bearer ${invitee.token}`)
        .send({token: created.body.token})

    return {invitee, created, accept}
  }

  it("rolls back acceptance when the invitation is revoked after being read", async () => {
    // Given: acceptance reads a pending invitation before the owner revokes it through HTTP.
    const {invitee, created, accept} = await createPendingInvitation()
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})
    const repository = app.get<InvitationRepository>(INVITATION_REPOSITORY_TOKEN)
    const read = wrapTaskEitherWithSideEffect(repository, "getById", async () => {
      // Revocation also reads the invitation; restore first so it cannot trigger this injection recursively.
      read.mockRestore()
      await request(app.getHttpServer())
        .delete(`${endpoint}/invitations/${created.body.id}`)
        .set("Authorization", `Bearer ${owner.token}`)
        .expect(HttpStatus.NO_CONTENT)
    })

    // When: acceptance tries to persist the pending version it read before revocation committed.
    const response = await accept()

    // Expect: the stale acceptance conflicts, its membership is rolled back, and revocation remains committed.
    expect(response.status).toBe(HttpStatus.CONFLICT)
    expect(response.body.code).toBe("CONCURRENT_MODIFICATION_ERROR")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toMatchObject({
      acceptedAt: null,
      revokedAt: expect.any(Date),
      occ: before.occ + 1n
    })
    expect(
      await prisma.user.count({
        where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id}
      })
    ).toBe(0)
    expect(await prisma.auditLog.count({where: {auditType: "INVITATION_ACCEPTED", entityId: created.body.id}})).toBe(0)
    expect(await prisma.auditLog.count({where: {auditType: "INVITATION_REVOKED", entityId: created.body.id}})).toBe(1)
  })

  it("rejects an expired invitation without consuming it or admitting a membership", async () => {
    // Given
    const {invitee, created} = await createPendingInvitation()
    await prisma.organizationInvitation.update({where: {id: created.body.id}, data: {expiresAt: new Date(0)}})
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations/${created.body.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: created.body.token})

    // Expect: expiry prevents acceptance and leaves the invitation and membership state unchanged.
    expect(response.status).toBe(HttpStatus.GONE)
    expect(response.body.code).toBe("INVITATION_EXPIRED")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
    expect(
      await prisma.user.count({
        where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id}
      })
    ).toBe(0)
    expect(await prisma.auditLog.count({where: {auditType: "INVITATION_ACCEPTED"}})).toBe(0)
  })

  it("rejects an incorrect token without consuming the invitation or admitting a membership", async () => {
    // Given
    const {invitee, created} = await createPendingInvitation()
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations/${created.body.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: "incorrect-token"})

    // Expect: an invalid token causes no invitation, membership, or acceptance-audit changes.
    expect(response.status).toBe(HttpStatus.NOT_FOUND)
    expect(response.body.code).toBe("INVITATION_INVALID")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
    expect(
      await prisma.user.count({
        where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id}
      })
    ).toBe(0)
    expect(await prisma.auditLog.count({where: {auditType: "INVITATION_ACCEPTED"}})).toBe(0)
  })

  it("does not reveal expiry to a caller with an incorrect token", async () => {
    // Given: an expired invitation whose token the caller does not possess.
    const {invitee, created} = await createPendingInvitation()
    await prisma.organizationInvitation.update({where: {id: created.body.id}, data: {expiresAt: new Date(0)}})
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations/${created.body.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: "incorrect-token"})

    // Expect: credential failure hides invitation state and leaves it unchanged.
    expect(response.status).toBe(HttpStatus.NOT_FOUND)
    expect(response.body.code).toBe("INVITATION_INVALID")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
  })

  it("does not reveal revocation to a different account even with the correct token", async () => {
    // Given: the intended invitee's invitation was revoked, but another account has its token.
    const {created} = await createPendingInvitation()
    await request(app.getHttpServer())
      .delete(`${endpoint}/invitations/${created.body.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(HttpStatus.NO_CONTENT)

    const other = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations/${created.body.id}/accept`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({token: created.body.token})

    // Expect: account mismatch hides invitation state and leaves it unchanged.
    expect(response.status).toBe(HttpStatus.NOT_FOUND)
    expect(response.body.code).toBe("INVITATION_INVALID")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
    expect(
      await prisma.user.count({where: {organizationId: owner.user.organizationId, platformAccountId: other.account.id}})
    ).toBe(0)
  })

  it("rejects acceptance when the inviter can no longer grant the requested role", async () => {
    // Given
    const {invitee, created} = await createPendingInvitation()
    await prisma.organizationInvitation.update({where: {id: created.body.id}, data: {requestedOrgRole: "owner"}})
    await prisma.user.update({where: {id: owner.user.id}, data: {orgRole: "admin"}})
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations/${created.body.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: created.body.token})

    // Expect: the inviter cannot grant owner access, so acceptance has no persisted side effects.
    expect(response.status).toBe(HttpStatus.FORBIDDEN)
    expect(response.body.code).toBe("INVITATION_GRANT_NO_LONGER_ALLOWED")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
    expect(
      await prisma.user.count({
        where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id}
      })
    ).toBe(0)
    expect(await prisma.auditLog.count({where: {auditType: "INVITATION_ACCEPTED"}})).toBe(0)
  })

  it("revokes a pending invitation once and prevents subsequent acceptance", async () => {
    // Given
    const {created, accept} = await createPendingInvitation()
    const revoke = () =>
      request(app.getHttpServer())
        .delete(`${endpoint}/invitations/${created.body.id}`)
        .set("Authorization", `Bearer ${owner.token}`)

    // When: the owner revokes the pending invitation.
    const revoked = await revoke()
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})

    // Expect: revocation succeeds and leaves the invitation unaccepted.
    expect(revoked.status).toBe(HttpStatus.NO_CONTENT)
    expect(before.revokedAt).toEqual(expect.any(Date))
    expect(before.acceptedAt).toBeNull()

    // When: the owner repeats the revocation.
    const repeated = await revoke()

    // Expect: the response identifies the revoked state without changing it or duplicating its audit.
    expect(repeated.status).toBe(HttpStatus.GONE)
    expect(repeated.body.code).toBe("INVITATION_REVOKED")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
    expect(await prisma.auditLog.count({where: {auditType: "INVITATION_REVOKED"}})).toBe(1)

    // When: the intended invitee attempts acceptance after revocation.
    const accepted = await accept()

    // Expect: acceptance reports the revoked state and cannot consume the invitation.
    expect(accepted.status).toBe(HttpStatus.GONE)
    expect(accepted.body.code).toBe("INVITATION_REVOKED")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
  })

  it("accepts a pending invitation and persists the new membership", async () => {
    // Given
    const {invitee, created, accept} = await createPendingInvitation()

    // When
    const response = await accept()

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body).toMatchObject({
      organizationId: owner.user.organizationId,
      accountId: invitee.account.id,
      orgRole: "member"
    })
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toMatchObject({
      acceptedAt: expect.any(Date),
      revokedAt: null
    })
  })

  it("rejects invitation creation for an active member without creating an invitation or audit", async () => {
    // Given: the invitee already joined through an earlier invitation.
    const {invitee, accept} = await createPendingInvitation()
    await accept().expect(HttpStatus.OK)
    const organizationId = owner.user.organizationId
    const membership = await prisma.user.findFirstOrThrow({
      where: {organizationId, platformAccountId: invitee.account.id}
    })
    const invitationCount = await prisma.organizationInvitation.count({where: {organizationId}})
    const auditCount = await prisma.auditLog.count({where: {organizationId, auditType: "INVITATION_CREATED"}})

    // When: the owner attempts another invitation for that active member.
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "admin"})

    // Expect: creation reports the membership conflict and leaves invitations, membership, and audit unchanged.
    expect(response.status).toBe(HttpStatus.CONFLICT)
    expect(response.body.code).toBe("MEMBERSHIP_ALREADY_ACTIVE")
    expect(await prisma.organizationInvitation.count({where: {organizationId}})).toBe(invitationCount)
    expect(await prisma.user.findUniqueOrThrow({where: {id: membership.id}})).toEqual(membership)
    expect(await prisma.auditLog.count({where: {organizationId, auditType: "INVITATION_CREATED"}})).toBe(auditCount)
  })
