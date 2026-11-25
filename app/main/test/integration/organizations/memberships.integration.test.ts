import {MEMBERSHIP_REPOSITORY_TOKEN, MembershipRepository} from "@services/tenancy/interfaces"
import {unwrapRight} from "@utils/either"
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
import {MockConfigProvider, createMockGroupInDb} from "@test/mock-data"
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
  let releaseOwnerRace: (() => void) | undefined

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
    releaseOwnerRace?.()
    releaseOwnerRace = undefined
    jest.restoreAllMocks()
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
    expect(response.body).toMatchObject({page: 1, limit: 20})
    expect(response.body.items).toHaveLength(1)
    expect(response.body.items[0]).not.toHaveProperty("etag")
  })

  it.each(["page=0", "page=1.5", "limit=0", "limit=101"])("rejects invalid pagination: %s", async query => {
    // Given
    const url = `${endpoint}/members?${query}`

    // When
    const response = await request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${owner.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.BAD_REQUEST)
    expect(response.body.code).toBe("INVALID_PAGINATION")
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

  it.each([
    {version: "current", offset: 0n, status: HttpStatus.NO_CONTENT, membershipStatus: "removed", groupCount: 0},
    {
      version: "stale",
      offset: 1n,
      status: HttpStatus.PRECONDITION_FAILED,
      code: "STALE_ETAG",
      membershipStatus: "active",
      groupCount: 1
    }
  ])("removes group memberships only with a $version membership version", async testCase => {
    // Given
    const organizationId = owner.user.organizationId
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {organizationId})
    const group = await createMockGroupInDb(prisma, {organizationId})
    const row = await prisma.user.findUniqueOrThrow({where: {id: member.user.id}})
    await prisma.groupMembership.create({
      data: {organizationId, groupId: group.id, userId: row.id, createdAt: new Date(), updatedAt: new Date()}
    })
    const etag = createEntityTag(configProvider.jwtConfig.secret, organizationId, row.id, row.occ + testCase.offset)

    // When
    const response = await request(app.getHttpServer())
      .delete(`${endpoint}/members/${row.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)

    // Expect
    expect(response.status).toBe(testCase.status)
    expect(response.body.code).toBe(testCase.code)
    expect(await prisma.user.findUniqueOrThrow({where: {id: row.id}})).toMatchObject({
      status: testCase.membershipStatus
    })
    expect(await prisma.groupMembership.count({where: {organizationId, userId: row.id}})).toBe(testCase.groupCount)
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

  it("prevents the last active owner from demoting or removing their own membership", async () => {
    // Given
    const membership = await prisma.user.findUniqueOrThrow({where: {id: owner.user.id}})
    const url = `${endpoint}/members/${membership.id}`
    const authorization = `Bearer ${owner.token}`
    const etag = createEntityTag(
      configProvider.jwtConfig.secret,
      membership.organizationId,
      membership.id,
      membership.occ
    )

    // When and Expect
    await request(app.getHttpServer())
      .patch(url)
      .set("Authorization", authorization)
      .set("If-Match", etag)
      .send({orgRole: "member"})
      .expect(HttpStatus.CONFLICT)
      .expect(({body}) => expect(body.code).toBe("ORGANIZATION_OWNER_REQUIRED"))

    // When and Expect
    await request(app.getHttpServer())
      .delete(url)
      .set("Authorization", authorization)
      .set("If-Match", etag)
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
      // Given
      const secondOwner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
        organizationId: owner.user.organizationId,
        orgRole: "owner"
      })
      const organizationId = owner.user.organizationId
      const baseUrl = `/o/${organizationId}/members`
      const firstMembership = await prisma.user.findUniqueOrThrow({where: {id: owner.user.id}})
      const secondMembership = await prisma.user.findUniqueOrThrow({where: {id: secondOwner.user.id}})
      const repository = app.get<MembershipRepository>(MEMBERSHIP_REPOSITORY_TOKEN)
      const countActiveOwners = repository.countActiveOwners.bind(repository)
      const observedCounts: number[] = []
      const bothCountsRead = new Promise<void>(resolve => {
        releaseOwnerRace = resolve
      })
      jest.spyOn(repository, "countActiveOwners").mockImplementation(context => async () => {
        const result = await countActiveOwners(context)()
        const count = unwrapRight(result)
        observedCounts.push(count)
        // Both first attempts must observe two owners before either is allowed to write.
        if (observedCounts.length === 2) releaseOwnerRace?.()
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
      }

      // When
      const responses = await Promise.all([
        mutate(firstAction, secondMembership, owner.token),
        mutate(secondAction, firstMembership, secondOwner.token)
      ])

      // Expect
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
    },
    15000
  )
})
