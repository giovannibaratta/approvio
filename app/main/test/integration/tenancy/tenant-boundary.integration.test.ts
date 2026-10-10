import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {AppModule} from "@app/app.module"
import {createEntityTag} from "@controllers/etag"
import {Account, AccountFactory} from "@domain"
import {ConfigProvider} from "@external/config"
import {Controller, Get, HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {FeatureGateService, TokenPayloadBuilder} from "@services"
import request from "supertest"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {createMockGroupInDb, MockConfigProvider} from "@test/mock-data"
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import * as TE from "fp-ts/TaskEither"
import {
  MEMBERSHIP_REPOSITORY_TOKEN,
  MembershipRepository,
  ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN,
  OrganizationDirectoryRepository
} from "@services/tenancy/interfaces"

@Controller("o/:organizationId/admission-policy-test")
class AdmissionPolicyTestController {
  @Get("unmarked")
  unmarked(): {ok: boolean} {
    return {ok: true}
  }
}

describe("Tenant boundary", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()
    let module: TestingModule
    try {
      module = await Test.createTestingModule({imports: [AppModule], controllers: [AdmissionPolicyTestController]})
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb))
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(isolatedDb)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)
    await app.init()
  }, 30000)

  afterEach(async () => {
    jest.restoreAllMocks()
    await cleanDatabase(prisma)
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  it("rejects a valid local credential retargeted to another organization", async () => {
    const first = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})
    const second = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      orgAdmin: true,
      organizationId: randomOrgId()
    })

    await request(app.getHttpServer())
      .get(`/o/${second.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${first.token}`)
      .expect(HttpStatus.FORBIDDEN)
      .expect(({body}) => expect(body.code).toBe("ORGANIZATION_MISMATCH"))
  })

  it("rejects an organization route without a credential", async () => {
    const organizationId = randomOrgId()

    const response = await request(app.getHttpServer()).get(`/o/${organizationId}/spaces`)
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED)
  })

  it("rejects resource access after suspension while allowing the owner's management summary", async () => {
    const owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
    await prisma.organization.update({
      where: {id: owner.user.organizationId},
      data: {status: "suspended", suspensionReason: "owner_requested"}
    })

    await request(app.getHttpServer())
      .get(`/o/${owner.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(HttpStatus.LOCKED)
      .expect(({body}) => expect(body.code).toBe("ORGANIZATION_SUSPENDED"))
    await request(app.getHttpServer())
      .get(`/o/${owner.user.organizationId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(HttpStatus.OK)
  })

  it("admits an active tenant endpoint without admission metadata", async () => {
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
    const response = await request(app.getHttpServer())
      .get(`/o/${member.user.organizationId}/admission-policy-test/unmarked`)
      .set("Authorization", `Bearer ${member.token}`)
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body).toEqual({ok: true})
  })

  it.each(["suspended", "deleting"] as const)(
    "rejects an undecorated tenant endpoint when the organization is %s",
    async status => {
      const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
      await prisma.organization.update({
        where: {id: member.user.organizationId},
        data: status === "suspended" ? {status, suspensionReason: "owner_requested"} : {status}
      })
      const response = await request(app.getHttpServer())
        .get(`/o/${member.user.organizationId}/admission-policy-test/unmarked`)
        .set("Authorization", `Bearer ${member.token}`)
      expect(response.status).toBe(status === "suspended" ? HttpStatus.LOCKED : HttpStatus.NOT_FOUND)
      expect(response.body.code).toBe(status === "suspended" ? "ORGANIZATION_SUSPENDED" : "RESOURCE_NOT_FOUND")
    }
  )

  it("rejects a stale browser context with 409 before reaching a tenant handler", async () => {
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
    await prisma.browserSession.updateMany({
      where: {accountId: member.user.accountId},
      data: {contextVersion: {increment: 1}}
    })
    await request(app.getHttpServer())
      .get(`/o/${member.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${member.token}`)
      .expect(HttpStatus.CONFLICT)
      .expect(({body}) => expect(body.code).toBe("ORGANIZATION_CONTEXT_CHANGED"))
  })

  it("rejects a committed membership removal without exposing tenant data", async () => {
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
    await prisma.user.update({where: {id: member.user.id}, data: {status: "removed", roles: []}})
    await request(app.getHttpServer())
      .get(`/o/${member.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${member.token}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect(({body}) => expect(body.code).toBe("USER_NOT_FOUND"))
  })

  it("rejects a committed browser session revocation", async () => {
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
    await prisma.browserSession.updateMany({where: {accountId: member.user.accountId}, data: {status: "revoked"}})
    const response = await request(app.getHttpServer())
      .get(`/o/${member.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${member.token}`)
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED)
  })

  it("fails closed when the admission storage lookup fails", async () => {
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
    const directory = app.get<OrganizationDirectoryRepository>(ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN)
    const failedLookup = jest.spyOn(directory, "get").mockReturnValueOnce(TE.left("repository_dependency_error"))
    try {
      await request(app.getHttpServer())
        .get(`/o/${member.user.organizationId}/spaces`)
        .set("Authorization", `Bearer ${member.token}`)
        .expect(HttpStatus.SERVICE_UNAVAILABLE)
        .expect(({body}) => expect(body.code).toBe("REPOSITORY_DEPENDENCY_ERROR"))
    } finally {
      failedLookup.mockRestore()
    }
  })

  it("rejects malformed organization context for an authenticated request", async () => {
    const user = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})

    await request(app.getHttpServer())
      .get("/o/not-a-uuid/spaces")
      .set("Authorization", `Bearer ${user.token}`)
      .expect(HttpStatus.BAD_REQUEST)
      .expect(({body}) => expect(body.code).toBe("INVALID_ORGANIZATION"))
  })

  it("lists only organizations belonging to the authenticated platform account", async () => {
    const firstAccount = await createPlatformAccountSession()
    const secondAccount = await createPlatformAccountSession()
    const firstOrganizationId = await createOrganization("first")
    const secondOrganizationId = await createOrganization("second")
    const thirdOrganizationId = await createOrganization("third")
    await Promise.all([
      createMembership(firstAccount.account.id, firstOrganizationId),
      createMembership(firstAccount.account.id, secondOrganizationId),
      createMembership(secondAccount.account.id, thirdOrganizationId)
    ])

    const firstResponse = await request(app.getHttpServer())
      .get("/organizations")
      .set("Authorization", `Bearer ${firstAccount.token}`)
      .expect(HttpStatus.OK)
    const secondResponse = await request(app.getHttpServer())
      .get("/organizations")
      .set("Authorization", `Bearer ${secondAccount.token}`)
      .expect(HttpStatus.OK)

    expect(firstResponse.body.items.map((organization: {id: string}) => organization.id).sort()).toEqual(
      [firstOrganizationId, secondOrganizationId].sort()
    )
    expect(secondResponse.body.items.map((organization: {id: string}) => organization.id)).toEqual([
      thirdOrganizationId
    ])
  })

  it("creates an organization and its initial owner atomically", async () => {
    const session = await createPlatformAccountSession()
    const slug = `created-${uuidv7()}`
    const response = await request(app.getHttpServer())
      .post("/organizations")
      .set("Authorization", `Bearer ${session.token}`)
      .send({slug, displayName: "New organization"})
      .expect(HttpStatus.CREATED)

    const persistedOrganization = await prisma.organization.findUniqueOrThrow({
      where: {id: response.body.organization.id},
      include: {users: true}
    })
    expect(response.body.organization).toMatchObject({id: persistedOrganization.id, slug, status: "active"})
    expect(persistedOrganization.planTier).toBe("SELF_HOSTED_UNLIMITED")
    expect(persistedOrganization.users).toHaveLength(1)
    expect(persistedOrganization.users[0]).toMatchObject({
      id: response.body.owner.id,
      platformAccountId: session.account.id,
      status: "active",
      orgRole: "owner"
    })
  })

  it("resolves entitlement tiers from each organization's persisted value", async () => {
    const freeOrganizationId = await createOrganization("free")
    const unlimitedOrganizationId = await createOrganization("unlimited")
    await prisma.organization.update({
      where: {id: unlimitedOrganizationId},
      data: {planTier: "SELF_HOSTED_UNLIMITED"}
    })
    const featureGate = app.get(FeatureGateService)

    const freeEntitlements = unwrapRight(
      await featureGate.getEffectiveEntitlements({organizationId: toOrganizationId(freeOrganizationId)})()
    )
    const unlimitedEntitlements = unwrapRight(
      await featureGate.getEffectiveEntitlements({organizationId: toOrganizationId(unlimitedOrganizationId)})()
    )

    expect(freeEntitlements).toMatchObject({planTier: "FREE", features: {platformLlmEvaluators: false}})
    expect(unlimitedEntitlements).toMatchObject({
      planTier: "SELF_HOSTED_UNLIMITED",
      features: {platformLlmEvaluators: true}
    })
  })

  it("prevents the last active owner from demoting or removing their own membership", async () => {
    const owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
    const baseUrl = `/o/${owner.user.organizationId}/members`
    const authorization = `Bearer ${owner.token}`
    const {body} = await request(app.getHttpServer())
      .get(baseUrl)
      .set("Authorization", authorization)
      .expect(HttpStatus.OK)
    const membership = body.items.find((item: {id: string}) => item.id === owner.user.id)
    // Given: obtain the mutation version from the individual resource response.
    const {headers: membershipHeaders} = await request(app.getHttpServer())
      .get(`${baseUrl}/${membership.id}`)
      .set("Authorization", authorization)
      .expect(HttpStatus.OK)

    await request(app.getHttpServer())
      .patch(`${baseUrl}/${membership.id}`)
      .set("Authorization", authorization)
      .set("If-Match", requireETag(membershipHeaders.etag))
      .send({orgRole: "member"})
      .expect(HttpStatus.CONFLICT)
      .expect(({body}) => expect(body.code).toBe("ORGANIZATION_OWNER_REQUIRED"))

    await request(app.getHttpServer())
      .delete(`${baseUrl}/${membership.id}`)
      .set("Authorization", authorization)
      .set("If-Match", requireETag(membershipHeaders.etag))
      .expect(HttpStatus.CONFLICT)
      .expect(({body}) => expect(body.code).toBe("ORGANIZATION_OWNER_REQUIRED"))
  })

  it.each([
    ["remove", "remove"],
    ["demote", "demote"],
    ["remove", "demote"]
  ] as const)(
    "keeps one active owner when %s and %s race",
    async (firstAction, secondAction) => {
      const firstOwner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
      const secondOwner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
        organizationId: firstOwner.user.organizationId,
        orgRole: "owner"
      })
      const organizationId = firstOwner.user.organizationId
      const baseUrl = `/o/${organizationId}/members`
      const firstMembership = await prisma.user.findUniqueOrThrow({where: {id: firstOwner.user.id}})
      const secondMembership = await prisma.user.findUniqueOrThrow({where: {id: secondOwner.user.id}})
      const repository = app.get<MembershipRepository>(MEMBERSHIP_REPOSITORY_TOKEN)
      const countActiveOwners = repository.countActiveOwners.bind(repository)
      const observedCounts: number[] = []
      let release: () => void = () => undefined
      const bothCountsRead = new Promise<void>(resolve => {
        release = resolve
      })
      const countSpy = jest.spyOn(repository, "countActiveOwners").mockImplementation(context => async () => {
        const result = await countActiveOwners(context)()
        const count = unwrapRight(result)
        observedCounts.push(count)
        // Both first attempts must observe two owners before either is allowed to write.
        if (observedCounts.length === 2) release()
        await bothCountsRead
        return result
      })

      const mutate = (action: "remove" | "demote", membership: typeof firstMembership, token: string) => {
        const endpoint = `${baseUrl}/${membership.id}`
        const mutation =
          action === "remove"
            ? request(app.getHttpServer()).delete(endpoint)
            : request(app.getHttpServer()).patch(endpoint).send({orgRole: "admin"})
        return mutation
          .set("Authorization", `Bearer ${token}`)
          .set(
            "If-Match",
            createEntityTag(configProvider.jwtConfig.secret, organizationId, membership.id, membership.occ)
          )
          .then(response => response)
      }

      try {
        const responses = await Promise.all([
          mutate(firstAction, secondMembership, firstOwner.token),
          mutate(secondAction, firstMembership, secondOwner.token)
        ])
        expect(observedCounts.slice(0, 2)).toEqual([2, 2])
        expect(observedCounts).toContain(1)
        expect(responses.filter(response => response.status < 300)).toHaveLength(1)
        expect(responses.find(response => response.status === 409)?.body.code).toBe("ORGANIZATION_OWNER_REQUIRED")
        await expect(prisma.user.count({where: {organizationId, status: "active", orgRole: "owner"}})).resolves.toBe(1)
        await expect(
          prisma.auditLog.count({
            where: {
              organizationId,
              auditType: {in: ["MEMBERSHIP_REMOVED", "MEMBERSHIP_ROLE_CHANGED"]}
            }
          })
        ).resolves.toBe(1)
      } finally {
        release()
        countSpy.mockRestore()
      }
    },
    15000
  )

  it("rejects a membership update with a stale ETag", async () => {
    const admin = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: admin.user.organizationId
    })
    const baseUrl = `/o/${admin.user.organizationId}/members`
    const authorization = `Bearer ${admin.token}`
    const {body} = await request(app.getHttpServer())
      .get(baseUrl)
      .set("Authorization", authorization)
      .expect(HttpStatus.OK)
    const memberSnapshot = body.items.find((item: {id: string}) => item.id === member.user.id)
    // Given: obtain the mutation version from the individual resource response.
    const {headers: memberSnapshotHeaders} = await request(app.getHttpServer())
      .get(`${baseUrl}/${memberSnapshot.id}`)
      .set("Authorization", authorization)
      .expect(HttpStatus.OK)

    await request(app.getHttpServer())
      .patch(`${baseUrl}/${memberSnapshot.id}`)
      .set("Authorization", authorization)
      .set("If-Match", requireETag(memberSnapshotHeaders.etag))
      .send({orgRole: "admin"})
      .expect(HttpStatus.OK)

    await request(app.getHttpServer())
      .delete(`${baseUrl}/${memberSnapshot.id}`)
      .set("Authorization", authorization)
      .set("If-Match", requireETag(memberSnapshotHeaders.etag))
      .expect(HttpStatus.PRECONDITION_FAILED)
      .expect(({body}) => expect(body.code).toBe("STALE_ETAG"))
  })

  it("removes a member's group links with their membership", async () => {
    const admin = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: admin.user.organizationId
    })
    const group = await createMockGroupInDb(prisma, {organizationId: admin.user.organizationId})
    await prisma.groupMembership.create({
      data: {
        organizationId: admin.user.organizationId,
        groupId: group.id,
        userId: member.user.id,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    const baseUrl = `/o/${admin.user.organizationId}/members`
    const authorization = `Bearer ${admin.token}`
    const {body} = await request(app.getHttpServer())
      .get(baseUrl)
      .set("Authorization", authorization)
      .expect(HttpStatus.OK)
    const memberSnapshot = body.items.find((item: {id: string}) => item.id === member.user.id)
    // Given: obtain the mutation version from the individual resource response.
    const {headers: memberSnapshotHeaders} = await request(app.getHttpServer())
      .get(`${baseUrl}/${memberSnapshot.id}`)
      .set("Authorization", authorization)
      .expect(HttpStatus.OK)

    await request(app.getHttpServer())
      .delete(`${baseUrl}/${memberSnapshot.id}`)
      .set("Authorization", authorization)
      .set("If-Match", requireETag(memberSnapshotHeaders.etag))
      .expect(HttpStatus.NO_CONTENT)

    await expect(
      prisma.groupMembership.count({where: {organizationId: admin.user.organizationId, userId: member.user.id}})
    ).resolves.toBe(0)
  })

  it("rolls back membership removal when its audit record cannot be persisted", async () => {
    const admin = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: admin.user.organizationId
    })
    const group = await createMockGroupInDb(prisma, {organizationId: admin.user.organizationId})
    await prisma.groupMembership.create({
      data: {
        organizationId: admin.user.organizationId,
        groupId: group.id,
        userId: member.user.id,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    const baseUrl = `/o/${admin.user.organizationId}/members`
    const authorization = `Bearer ${admin.token}`
    const {body} = await request(app.getHttpServer())
      .get(baseUrl)
      .set("Authorization", authorization)
      .expect(HttpStatus.OK)
    const memberSnapshot = body.items.find((item: {id: string}) => item.id === member.user.id)
    // Given: obtain the mutation version from the individual resource response.
    const {headers: memberSnapshotHeaders} = await request(app.getHttpServer())
      .get(`${baseUrl}/${memberSnapshot.id}`)
      .set("Authorization", authorization)
      .expect(HttpStatus.OK)

    try {
      await prisma.$executeRaw`
        CREATE OR REPLACE FUNCTION reject_membership_removed_audit() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.audit_type = 'MEMBERSHIP_REMOVED' THEN
            RAISE EXCEPTION 'forced audit persistence failure';
          END IF;
          RETURN NEW;
        END
        $$
      `
      await prisma.$executeRaw`
        CREATE TRIGGER test_reject_membership_removed_audit
        BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION reject_membership_removed_audit()
      `

      await request(app.getHttpServer())
        .delete(`${baseUrl}/${memberSnapshot.id}`)
        .set("Authorization", authorization)
        .set("If-Match", requireETag(memberSnapshotHeaders.etag))
        .expect(HttpStatus.SERVICE_UNAVAILABLE)
        .expect(({body}) => expect(body.code).toBe("STORAGE_UNAVAILABLE"))

      await expect(
        prisma.user.findUniqueOrThrow({
          where: {organizationId_id: {organizationId: admin.user.organizationId, id: member.user.id}}
        })
      ).resolves.toMatchObject({status: "active"})
      await expect(
        prisma.groupMembership.count({where: {organizationId: admin.user.organizationId, userId: member.user.id}})
      ).resolves.toBe(1)
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS test_reject_membership_removed_audit ON audit_logs`
      await prisma.$executeRaw`DROP FUNCTION IF EXISTS reject_membership_removed_audit()`
    }
  })

  it("accepts invitations only with the matching platform account, once", async () => {
    const owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      orgRole: "owner"
    })
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    const invitee = await createPlatformAccountSession()
    const baseUrl = `/o/${owner.user.organizationId}/invitations`
    const {body: invitation} = await request(app.getHttpServer())
      .post(baseUrl)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "member"})
      .expect(HttpStatus.CREATED)

    await request(app.getHttpServer())
      .post(`${baseUrl}/${invitation.id}/accept`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({token: invitation.token})
      .expect(HttpStatus.UNAUTHORIZED)

    const ownerAccount = unwrapRight(
      AccountFactory.validate(await prisma.platformAccount.findUniqueOrThrow({where: {id: owner.user.accountId}}))
    )
    const ownerPlatformToken = signPlatformToken(
      ownerAccount,
      configProvider,
      jwtService,
      ownerSession.providerId,
      ownerSession.id
    )
    await request(app.getHttpServer())
      .post(`${baseUrl}/${invitation.id}/accept`)
      .set("Authorization", `Bearer ${ownerPlatformToken}`)
      .send({token: invitation.token})
      .expect(HttpStatus.NOT_FOUND)
      .expect(({body}) => expect(body.code).toBe("INVITATION_INVALID"))

    const accepted = await request(app.getHttpServer())
      .post(`${baseUrl}/${invitation.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: invitation.token})
      .expect(HttpStatus.OK)
    expect(accepted.body).toMatchObject({
      accountId: invitee.account.id,
      organizationId: owner.user.organizationId,
      orgRole: "member"
    })

    await request(app.getHttpServer())
      .post(`${baseUrl}/${invitation.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: invitation.token})
      .expect(HttpStatus.NOT_FOUND)
      .expect(({body}) => expect(body.code).toBe("INVITATION_INVALID"))
  })

  it("does not accept invitations for a disabled platform account", async () => {
    const owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
    const invitee = await createPlatformAccountSession()
    const baseUrl = `/o/${owner.user.organizationId}/invitations`
    const {body: invitation} = await request(app.getHttpServer())
      .post(baseUrl)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "member"})
      .expect(HttpStatus.CREATED)

    await prisma.platformAccount.update({
      where: {id: invitee.account.id},
      data: {status: "disabled"}
    })

    await request(app.getHttpServer())
      .post(`${baseUrl}/${invitation.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: invitation.token})
      .expect(HttpStatus.NOT_FOUND)
      .expect(({body}) => expect(body.code).toBe("INVITATION_INVALID"))

    await expect(
      prisma.user.count({where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id}})
    ).resolves.toBe(0)
  })

  it("accepts an invitation only once when the target account races two requests", async () => {
    const owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
    const invitee = await createPlatformAccountSession()
    const baseUrl = `/o/${owner.user.organizationId}/invitations`
    const {body: invitation} = await request(app.getHttpServer())
      .post(baseUrl)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "member"})
      .expect(HttpStatus.CREATED)

    let release: () => void = () => undefined
    let signalLock: () => void = () => undefined
    const lockReleased = new Promise<void>(resolve => {
      release = resolve
    })
    const lockAcquired = new Promise<void>(resolve => {
      signalLock = resolve
    })
    // Given: hold the invitation row that acceptance locks before checking its pending state.
    // Both requests must reach that database lock before either may consume the invitation.
    const blocker = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM organization_invitations WHERE organization_id = ${owner.user.organizationId}::uuid AND id = ${invitation.id}::uuid FOR UPDATE`
      signalLock()
      await lockReleased
    })
    await lockAcquired

    const accept = () =>
      request(app.getHttpServer())
        .post(`${baseUrl}/${invitation.id}/accept`)
        .set("Authorization", `Bearer ${invitee.token}`)
        .send({token: invitation.token})
        .then(response => response)
    const firstAcceptance = accept()
    const secondAcceptance = accept()
    let bothRequestsBlocked: boolean
    try {
      bothRequestsBlocked = await waitForInvitationLockWaiters(prisma)
    } finally {
      release()
    }
    await blocker
    const responses = await Promise.all([firstAcceptance, secondAcceptance])

    expect(bothRequestsBlocked).toBe(true)
    expect(responses.map(response => response.status).sort((left, right) => left - right)).toEqual([
      HttpStatus.OK,
      HttpStatus.NOT_FOUND
    ])
    await expect(
      prisma.user.count({
        where: {organizationId: owner.user.organizationId, platformAccountId: invitee.account.id, status: "active"}
      })
    ).resolves.toBe(1)
  }, 15000)

  it("rejects invitation acceptance after the inviter loses grant authority", async () => {
    const owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
    const otherOwner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId: owner.user.organizationId,
      orgRole: "owner"
    })
    const invitee = await createPlatformAccountSession()
    const baseUrl = `/o/${owner.user.organizationId}`
    const {body: invitation} = await request(app.getHttpServer())
      .post(`${baseUrl}/invitations`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "owner"})
      .expect(HttpStatus.CREATED)
    const {
      body: {items}
    } = await request(app.getHttpServer())
      .get(`${baseUrl}/members`)
      .set("Authorization", `Bearer ${otherOwner.token}`)
      .expect(HttpStatus.OK)
    const ownerSnapshot = items.find((item: {id: string}) => item.id === owner.user.id)
    const {headers: ownerHeaders} = await request(app.getHttpServer())
      .get(`${baseUrl}/members/${ownerSnapshot.id}`)
      .set("Authorization", `Bearer ${otherOwner.token}`)
      .expect(HttpStatus.OK)

    await request(app.getHttpServer())
      .patch(`${baseUrl}/members/${owner.user.id}`)
      .set("Authorization", `Bearer ${otherOwner.token}`)
      .set("If-Match", requireETag(ownerHeaders.etag))
      .send({orgRole: "admin"})
      .expect(HttpStatus.OK)

    await request(app.getHttpServer())
      .post(`${baseUrl}/invitations/${invitation.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: invitation.token})
      .expect(HttpStatus.NOT_FOUND)
      .expect(({body}) => expect(body.code).toBe("INVITATION_INVALID"))
  })

  it("rejects an expired invitation", async () => {
    const owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
    const invitee = await createPlatformAccountSession()
    const baseUrl = `/o/${owner.user.organizationId}/invitations`
    const {body: invitation} = await request(app.getHttpServer())
      .post(baseUrl)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({accountId: invitee.account.id, orgRole: "member"})
      .expect(HttpStatus.CREATED)
    await prisma.organizationInvitation.update({
      where: {organizationId_id: {organizationId: owner.user.organizationId, id: invitation.id}},
      data: {expiresAt: new Date(Date.now() - 1000)}
    })

    await request(app.getHttpServer())
      .post(`${baseUrl}/${invitation.id}/accept`)
      .set("Authorization", `Bearer ${invitee.token}`)
      .send({token: invitation.token})
      .expect(HttpStatus.NOT_FOUND)
      .expect(({body}) => expect(body.code).toBe("INVITATION_INVALID"))
  })

  async function createPlatformAccountSession(): Promise<{account: Account; token: string}> {
    const id = uuidv7()
    const sessionId = uuidv7()
    const providerId = "custom"
    const now = new Date()
    const account = unwrapRight(
      AccountFactory.validate(
        await prisma.platformAccount.create({
          data: {
            id,
            displayName: "Invitation recipient",
            profileEmail: `${id}@example.test`,
            status: "active",
            createdAt: now,
            updatedAt: now,
            occ: 0n
          }
        })
      )
    )
    await prisma.browserSession.create({
      data: {
        id: sessionId,
        accountId: account.id,
        providerId: providerId,
        contextVersion: 0n,
        selectedOrganizationId: null,
        transport: "browser",
        status: "active",
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
        occ: 0n
      }
    })
    return {
      account,
      token: signPlatformToken(account, configProvider, jwtService, providerId, sessionId)
    }
  }

  async function createOrganization(label: string): Promise<string> {
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

  async function createMembership(accountId: string, organizationId: string): Promise<void> {
    const now = new Date()
    await prisma.user.create({
      data: {
        id: uuidv7(),
        organizationId,
        platformAccountId: accountId,
        displayName: "Local member",
        status: "active",
        orgRole: "member",
        roles: [],
        createdAt: now,
        updatedAt: now,
        occ: 0n
      }
    })
  }
})

function signPlatformToken(
  account: Account,
  config: ConfigProvider,
  jwtService: JwtService,
  providerId: string,
  sessionId: string
): string {
  return jwtService.sign(
    TokenPayloadBuilder.fromPlatformAccount(account, {
      issuer: config.jwtConfig.issuer,
      audience: [config.jwtConfig.audience],
      providerId: providerId,
      sessionId,
      sessionContextVersion: 0n
    })
  )
}

async function waitForInvitationLockWaiters(prisma: PrismaClient, expected = 2n): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await prisma.$queryRaw<ReadonlyArray<{count: bigint}>>`
      SELECT count(*)::bigint AS count
      FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query ILIKE '%FROM organization_invitations%'
        AND query ILIKE '%FOR UPDATE%'
    `
    if ((rows[0]?.count ?? 0n) >= expected) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

function requireETag(value: string | undefined): string {
  if (value === undefined) throw new Error("Individual membership response must include an ETag")
  return value
}
