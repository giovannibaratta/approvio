import * as E from "fp-ts/Either"
import {INVITATION_REPOSITORY_TOKEN, InvitationRepository} from "@services"
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
    await cleanDatabase(prisma)
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
    await cleanRedisByPrefix(redisPrefix)
  })

  async function pendingInvitation() {
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

  it("rolls back membership admission when the invitation version changes after reading", async () => {
    // Given
    const {invitee, created, accept} = await pendingInvitation()
    const repository = app.get<InvitationRepository>(INVITATION_REPOSITORY_TOKEN)
    const getById = repository.getById.bind(repository)
    const read = jest.spyOn(repository, "getById").mockImplementationOnce((context, invitationId) => async () => {
      const result = await getById(context, invitationId)()
      if (E.isRight(result))
        await prisma.organizationInvitation.update({
          where: {organizationId_id: {organizationId: context.organizationId, id: invitationId}},
          data: {occ: {increment: 1}}
        })
      return result
    })

    try {
      // When
      const response = await accept()

      // Expect
      expect(response.status).toBe(HttpStatus.CONFLICT)
      expect(response.body.code).toBe("CONCURRENT_MODIFICATION_ERROR")
      expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toMatchObject({
        acceptedAt: null,
        revokedAt: null,
        occ: 1n
      })
      expect(
        await prisma.user.count({
          where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id}
        })
      ).toBe(0)
      expect(await prisma.auditLog.count({where: {auditType: "INVITATION_ACCEPTED"}})).toBe(0)
    } finally {
      read.mockRestore()
    }
  })

  it.each(["expired", "invalid_token", "inviter_cannot_grant"] as const)(
    "rejects %s acceptance without admitting a membership or consuming the invitation",
    async failure => {
      // Given
      const {invitee, created} = await pendingInvitation()
      if (failure === "expired")
        await prisma.organizationInvitation.update({where: {id: created.body.id}, data: {expiresAt: new Date(0)}})
      if (failure === "inviter_cannot_grant") {
        await prisma.organizationInvitation.update({where: {id: created.body.id}, data: {requestedOrgRole: "owner"}})
        await prisma.user.update({where: {id: owner.user.id}, data: {orgRole: "admin"}})
      }
      const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})

      // When
      const response = await request(app.getHttpServer())
        .post(`${endpoint}/invitations/${created.body.id}/accept`)
        .set("Authorization", `Bearer ${invitee.token}`)
        .send({token: failure === "invalid_token" ? "incorrect-token" : created.body.token})

      // Expect
      expect(response.status).toBe(HttpStatus.NOT_FOUND)
      expect(response.body.code).toBe("INVITATION_INVALID")
      expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
      expect(
        await prisma.user.count({
          where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id}
        })
      ).toBe(0)
      expect(await prisma.auditLog.count({where: {auditType: "INVITATION_ACCEPTED"}})).toBe(0)
    }
  )

  it("revokes a pending invitation once and prevents subsequent acceptance", async () => {
    // Given
    const {created, accept} = await pendingInvitation()
    const revoke = () =>
      request(app.getHttpServer())
        .delete(`${endpoint}/invitations/${created.body.id}`)
        .set("Authorization", `Bearer ${owner.token}`)

    // When
    await revoke().expect(HttpStatus.NO_CONTENT)
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})
    const repeated = await revoke()
    const accepted = await accept()

    // Expect
    expect(before.revokedAt).toEqual(expect.any(Date))
    expect(before.acceptedAt).toBeNull()
    expect(repeated.status).toBe(HttpStatus.NOT_FOUND)
    expect(repeated.body.code).toBe("INVITATION_INVALID")
    expect(accepted.status).toBe(HttpStatus.NOT_FOUND)
    expect(accepted.body.code).toBe("INVITATION_INVALID")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
    expect(await prisma.auditLog.count({where: {auditType: "INVITATION_REVOKED"}})).toBe(1)
  })

  it("accepts a pending invitation and persists the new membership", async () => {
    // Given
    const {invitee, created, accept} = await pendingInvitation()

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

  it("preserves the active membership conflict without consuming a valid invitation", async () => {
    // Given
    const {invitee, accept} = await pendingInvitation()
    await accept().expect(HttpStatus.OK)
    const created = await request(app.getHttpServer())
      .post(`${endpoint}/invitations`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "admin"})
      .expect(HttpStatus.CREATED)
    const before = await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})
    const membership = await prisma.user.findFirstOrThrow({
      where: {
        organizationId: owner.user.organizationId,
        platformAccountId: invitee.account.id
      }
    })
    const auditCount = await prisma.auditLog.count({where: {auditType: "INVITATION_ACCEPTED"}})

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/invitations/${created.body.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: created.body.token})

    // Expect
    expect(response.status).toBe(HttpStatus.CONFLICT)
    expect(response.body.code).toBe("MEMBERSHIP_ALREADY_ACTIVE")
    expect(await prisma.organizationInvitation.findUniqueOrThrow({where: {id: created.body.id}})).toEqual(before)
    expect(await prisma.user.findUniqueOrThrow({where: {id: membership.id}})).toEqual(membership)
    expect(await prisma.auditLog.count({where: {auditType: "INVITATION_ACCEPTED"}})).toBe(auditCount)
  })

  it("rejects an invitation that has already been accepted", async () => {
    // Given
    const {invitee, accept} = await pendingInvitation()
    await accept().expect(HttpStatus.OK)

    // When
    const response = await accept()

    // Expect
    expect(response.status).toBe(HttpStatus.NOT_FOUND)
    expect(response.body.code).toBe("INVITATION_INVALID")
    expect(
      await prisma.user.count({
        where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id}
      })
    ).toBe(1)
  })

  it("rejects a pending invitation retargeted to another organization", async () => {
    // Given
    const {invitee, created, accept} = await pendingInvitation()
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
    expect(removed.roles).toBeNull()
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
      roles: null
    })
  })
})
