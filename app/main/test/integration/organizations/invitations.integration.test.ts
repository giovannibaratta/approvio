import {INVITATION_REPOSITORY_TOKEN, InvitationRepository} from "@services"
import {wrapTaskEitherWithSideEffect} from "@test/injectors"
import {SystemRole} from "@domain"
import {createPlatformSessionInDb} from "@test/platform-session"
import {createEntityTag} from "@controllers/etag"
import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {POSTGRES_BIGINT_LOWER_BOUND} from "@external/database/constants"
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
import {MockConfigProvider, createMockUserInDb} from "@test/mock-data"
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
  let releaseAcceptanceRace: (() => void) | undefined

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
    releaseAcceptanceRace?.()
    releaseAcceptanceRace = undefined
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

  it("rejects a second live pending invitation without changing the first or adding an audit", async () => {
    // Given
    const {invitee, created} = await createPendingInvitation()
    const organizationId = owner.user.organizationId
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})

    // When: another role is offered to the same account while its invitation is still live.
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "admin"})

    // Expect: only the original token and role offer remain valid, with no duplicate creation audit.
    expect(response.status).toBe(HttpStatus.CONFLICT)
    expect(response.body.code).toBe("INVITATION_ALREADY_PENDING")
    expect(
      await prisma.organizationInvitation.findMany({where: {organizationId, targetAccountId: invitee.account.id}})
    ).toEqual([before])
    expect(await prisma.auditLog.count({where: {organizationId, auditType: "INVITATION_CREATED"}})).toBe(1)
  })

  it("allows a pending invitation for another account in the same organization", async () => {
    // Given
    await createPendingInvitation()
    const other = await createPlatformSessionInDb(prisma, jwtService, configProvider)

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: other.account.id, orgRole: "member"})

    // Expect: pending invitations are limited per account, not per organization.
    expect(response.status).toBe(HttpStatus.CREATED)
    expect(await prisma.organizationInvitation.count({where: {organizationId: owner.user.organizationId}})).toBe(2)
  })

  it("allows the same account to have pending invitations in different organizations", async () => {
    // Given
    const {invitee} = await createPendingInvitation()
    const otherOwner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})

    // When
    const response = await request(app.getHttpServer())
      .post(`/o/${otherOwner.user.organizationId}/invitations`)
      .set("Authorization", `Bearer ${otherOwner.token}`)
      .send({accountId: invitee.account.id, orgRole: "member"})

    // Expect: an invitation in one organization does not prevent joining another.
    expect(response.status).toBe(HttpStatus.CREATED)
    expect(await prisma.organizationInvitation.count({where: {targetAccountId: invitee.account.id}})).toBe(2)
  })

  it("rejects the stale creation after a competing request creates a pending invitation", async () => {
    // Given: the first transaction reads no pending invitation before a competing HTTP creation commits.
    const invitee = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    const organizationId = owner.user.organizationId
    const repository = app.get<InvitationRepository>(INVITATION_REPOSITORY_TOKEN)
    const read = wrapTaskEitherWithSideEffect(repository, "hasPending", async () => {
      read.mockRestore()
      await request(app.getHttpServer())
        .post(`${endpoint}/invitations`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({accountId: invitee.account.id, orgRole: "member"})
        .expect(HttpStatus.CREATED)
    })

    // When: the stale transaction attempts to insert its conflicting role offer.
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "admin"})

    // Expect: Serializable retry observes the committed invitation and returns the precise duplicate error.
    expect(response.status).toBe(HttpStatus.CONFLICT)
    expect(response.body.code).toBe("INVITATION_ALREADY_PENDING")
    const pending = await prisma.organizationInvitation.findMany({
      where: {organizationId, targetAccountId: invitee.account.id}
    })
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({requestedOrgRole: "member", acceptedAt: null, revokedAt: null})
    expect(await prisma.auditLog.count({where: {organizationId, auditType: "INVITATION_CREATED"}})).toBe(1)
  })

  it("allows a new invitation after the previous invitation expires", async () => {
    // Given
    const {invitee, created} = await createPendingInvitation()
    await prisma.organizationInvitation.update({where: {id: created.body.id}, data: {expiresAt: new Date(0)}})
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "member"})

    // Expect: expiry permits a new token without rewriting the old invitation.
    expect(response.status).toBe(HttpStatus.CREATED)
    expect(response.body.id).not.toBe(created.body.id)
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
    expect(
      await prisma.organizationInvitation.count({
        where: {organizationId: owner.user.organizationId, targetAccountId: invitee.account.id}
      })
    ).toBe(2)
  })

  it("allows a new invitation after the previous invitation is revoked", async () => {
    // Given
    const {invitee, created} = await createPendingInvitation()
    await request(app.getHttpServer())
      .delete(`${endpoint}/invitations/${created.body.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(HttpStatus.NO_CONTENT)
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "member"})

    // Expect: revocation permits a new token and keeps the revoked invitation unchanged.
    expect(response.status).toBe(HttpStatus.CREATED)
    expect(response.body.id).not.toBe(created.body.id)
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
    expect(
      await prisma.organizationInvitation.count({
        where: {organizationId: owner.user.organizationId, targetAccountId: invitee.account.id}
      })
    ).toBe(2)
  })

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

  it("requires a platform credential to accept an invitation", async () => {
    // Given
    const {created} = await createPendingInvitation()

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations/${created.body.id}/accept`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({token: created.body.token})

    // Expect
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED)
  })

  it("does not accept invitations for a disabled platform account", async () => {
    // Given
    const {invitee, accept} = await createPendingInvitation()

    await prisma.platformAccount.update({
      where: {id: invitee.account.id},
      data: {status: "disabled"}
    })

    // When and Expect
    await accept()
      .expect(HttpStatus.NOT_FOUND)
      .expect(({body}) => expect(body.code).toBe("INVITATION_INVALID"))

    await expect(
      prisma.user.count({where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id}})
    ).resolves.toBe(0)
  })

  it("accepts an invitation only once when the target account races two requests", async () => {
    // Given
    const {invitee, created, accept} = await createPendingInvitation()
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})

    const repository = app.get<InvitationRepository>(INVITATION_REPOSITORY_TOKEN)
    let reads = 0
    const bothRead = new Promise<void>(resolve => {
      releaseAcceptanceRace = resolve
    })
    // Both requests read the pending invitation before either can accept it.
    // Persistence uses OCC; the losing transaction must roll back its membership writes.
    wrapTaskEitherWithSideEffect(repository, "getById", async () => {
      reads++
      if (reads === 2) releaseAcceptanceRace?.()
      await bothRead
    })

    // When
    const responses = await Promise.all([accept(), accept()])

    // Expect
    expect(reads).toBe(2)
    expect(responses.map(response => response.status).sort((left, right) => left - right)).toEqual([
      HttpStatus.OK,
      HttpStatus.CONFLICT
    ])

    const accepted = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})
    expect(accepted.acceptedAt).not.toBeNull()
    expect(accepted.occ).toBe(before.occ + 1n)
    await expect(
      prisma.user.count({
        where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id, status: "active"}
      })
    ).resolves.toBe(1)
  }, 15000)

  it("accepts a pending invitation and persists the new membership", async () => {
    // Given
    const {invitee, created, accept} = await createPendingInvitation()
    expect(await prisma.platformAccountIdentity.count({where: {accountId: invitee.account.id}})).toBe(0)

    // When
    const response = await accept()

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body).toMatchObject({
      organizationId: owner.user.organizationId,
      accountId: invitee.account.id,
      orgRole: "member"
    })
    expect(
      await prisma.user.findUniqueOrThrow({
        where: {
          organizationId_platformAccountId: {
            organizationId: owner.user.organizationId,
            platformAccountId: invitee.account.id
          }
        }
      })
    ).toMatchObject({
      organizationId: owner.user.organizationId,
      platformAccountId: invitee.account.id,
      displayName: "Member",
      orgRole: "member",
      occ: POSTGRES_BIGINT_LOWER_BOUND
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

  it("rejects acceptance when membership becomes active after invitation creation", async () => {
    // Given: an independent membership admission commits while this invitation remains pending.
    const {invitee, created} = await createPendingInvitation()
    await createMockUserInDb(prisma, {
      organizationId: owner.user.organizationId,
      platformAccountId: invitee.account.id,
      orgRole: "member"
    })
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})
    const membership = await prisma.user.findFirstOrThrow({
      where: {
        organizationId: owner.user.organizationId,
        platformAccountId: invitee.account.id
      }
    })
    const auditCount = await prisma.auditLog.count({where: {auditType: "INVITATION_ACCEPTED"}})

    // When: the invitee accepts the still-pending invitation after becoming a member.
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations/${created.body.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: created.body.token})

    // Expect: acceptance rechecks membership and preserves the unused invitation and existing member.
    expect(response.status).toBe(HttpStatus.CONFLICT)
    expect(response.body.code).toBe("MEMBERSHIP_ALREADY_ACTIVE")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
    expect(await prisma.user.findUniqueOrThrow({where: {id: membership.id}})).toEqual(membership)
    expect(await prisma.auditLog.count({where: {auditType: "INVITATION_ACCEPTED"}})).toBe(auditCount)
  })

  it("rejects an invitation that has already been accepted", async () => {
    // Given
    const {invitee, accept} = await createPendingInvitation()
    await accept().expect(HttpStatus.OK)

    // When
    const response = await accept()

    // Expect
    expect(response.status).toBe(HttpStatus.CONFLICT)
    expect(response.body.code).toBe("INVITATION_ALREADY_ACCEPTED")
    expect(
      await prisma.user.count({
        where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id}
      })
    ).toBe(1)
  })

  it("rejects a pending invitation retargeted to another organization", async () => {
    // Given
    const {invitee, created, accept} = await createPendingInvitation()
    const other = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})

    // When
    const response = await accept(other.user.organizationId)

    // Expect
    expect(response.status).toBe(HttpStatus.NOT_FOUND)
    expect(response.body.code).toBe("INVITATION_INVALID")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toMatchObject({
      acceptedAt: null,
      revokedAt: null
    })
    expect(
      await prisma.user.count({
        where: {organizationId: other.user.organizationId, platformAccountId: invitee.account.id}
      })
    ).toBe(0)
  })

  it("readmits a removed membership with its original ID and newly granted role", async () => {
    // Given
    const invitee = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    const createInvitation = (orgRole: string) =>
      request(app.getHttpServer())
        .post(`${endpoint}/invitations`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({accountId: invitee.account.id, orgRole})
    const first = await createInvitation("member").expect(HttpStatus.CREATED)
    const admitted = await request(app.getHttpServer())
      .post(`${endpoint}/invitations/${first.body.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: first.body.token})
      .expect(HttpStatus.OK)
    const membership = await prisma.user.findUniqueOrThrow({where: {id: admitted.body.id}})
    const role = SystemRole.createWorkflowTemplateVoterRole({type: "org", organizationId: owner.user.organizationId})
    await prisma.user.update({
      where: {id: membership.id},
      data: {
        roles: [
          {
            name: role.name,
            resourceType: role.resourceType,
            scopeType: role.scopeType,
            permissions: [...role.permissions],
            scope: {type: "org", organizationId: owner.user.organizationId}
          }
        ]
      }
    })

    await request(app.getHttpServer())
      .delete(`${endpoint}/members/${membership.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set(
        "If-Match",
        createEntityTag(configProvider.jwtConfig.secret, membership.organizationId, membership.id, membership.occ)
      )
      .expect(HttpStatus.NO_CONTENT)
    const removed = await prisma.user.findUniqueOrThrow({where: {id: membership.id}})
    expect(removed.status).toBe("removed")
    expect(removed.roles).toEqual([])
    const second = await createInvitation("admin").expect(HttpStatus.CREATED)

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations/${second.body.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: second.body.token})

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body).toMatchObject({
      id: membership.id,
      accountId: invitee.account.id,
      status: "active",
      orgRole: "admin"
    })
    expect(
      await prisma.user.count({
        where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id}
      })
    ).toBe(1)
    expect(await prisma.user.findUniqueOrThrow({where: {id: membership.id}})).toMatchObject({
      status: "active",
      orgRole: "admin",
      roles: []
    })
  })
})
