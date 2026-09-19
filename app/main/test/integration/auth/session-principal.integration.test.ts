import {createSessionTag} from "@controllers/etag"
import {createPlatformSessionInDb} from "@test/platform-session"
import {AccountFactory, UserFactory} from "@domain"
import {v4 as uuidv4, v7 as uuidv7} from "uuid"
import {TokenPayloadBuilder} from "@services"
import {wrapTaskEitherWithSideEffect} from "@test/injectors"
import {MEMBERSHIP_REPOSITORY_TOKEN, MembershipRepository} from "@services/tenancy/interfaces"
import {mapAgentToDomain} from "@external/database/shared"
import {createMockAgentInDb, createMockUserInDb} from "@test/mock-data"
import {TestTokenBuilder} from "@test/token-helpers"
import {unwrapRight} from "@utils/either"
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

describe("Session principal API", () => {
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
    // This owner has its own login account, session, and membership in the target organization.
    owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
    endpoint = `/o/${owner.user.organizationId}`
  })

  afterEach(async () => {
    // Restore repository hooks used to simulate competing database updates.
    jest.restoreAllMocks()
    await cleanDatabase(prisma)
    await cleanRedisByPrefix(redisPrefix)
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
  })

  it("rejects a signed user token with disabled account", async () => {
    // Given
    await prisma.platformAccount.update({where: {id: owner.user.accountId}, data: {status: "disabled"}})

    // When
    const response = await request(app.getHttpServer()).get(endpoint).set("Authorization", `Bearer ${owner.token}`)

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
    expect(response.body).toHaveErrorCode("INVALID_SESSION")
  })

  it("rejects a signed user token with expired session", async () => {
    // Given: Use the persisted session belonging to the owner account.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    await prisma.browserSession.update({where: {id: ownerSession.id}, data: {expiresAt: new Date(0)}})

    // When
    const response = await request(app.getHttpServer()).get(endpoint).set("Authorization", `Bearer ${owner.token}`)

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
    expect(response.body).toHaveErrorCode("INVALID_SESSION")
  })

  it("rejects a signed user token with no selected organization", async () => {
    // Given: Use the persisted session belonging to the owner account.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    await prisma.browserSession.update({where: {id: ownerSession.id}, data: {selectedOrganizationId: null}})

    // When
    const response = await request(app.getHttpServer()).get(endpoint).set("Authorization", `Bearer ${owner.token}`)

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
    expect(response.body).toHaveErrorCode("INVALID_SESSION")
  })

  it("authenticates an active agent against its current persisted status", async () => {
    // Given
    const agent = await createMockAgentInDb(prisma, {organizationId: owner.user.organizationId})
    const token = TestTokenBuilder.signAgentToken(jwtService, configProvider, unwrapRight(mapAgentToDomain(agent)))

    // When
    const response = await request(app.getHttpServer()).get(endpoint).set("Authorization", `Bearer ${token}`)

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.OK)
    expect(response.body).toMatchObject({id: owner.user.organizationId})
  })

  it("rejects a revoked agent against its current persisted status", async () => {
    // Given
    const agent = await createMockAgentInDb(prisma, {organizationId: owner.user.organizationId})
    const token = TestTokenBuilder.signAgentToken(jwtService, configProvider, unwrapRight(mapAgentToDomain(agent)))
    await prisma.agent.update({where: {id: agent.id}, data: {status: "revoked"}})

    // When
    const response = await request(app.getHttpServer()).get(endpoint).set("Authorization", `Bearer ${token}`)

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
    expect(response.body).toHaveErrorCode("AGENT_REVOKED")
  })

  it("preserves a platform session context version beyond JavaScript's safe integer range", async () => {
    // Given: The helper creates the requesting account and a session owned by that account.
    const {
      account: requestingAccount,
      sessionId: requestingSessionId,
      token: requestingToken
    } = await createPlatformSessionInDb(prisma, jwtService, configProvider, 9_007_199_254_740_993n)

    // When
    const response = await request(app.getHttpServer())
      .get("/auth/web/session")
      .set("Authorization", `Bearer ${requestingToken}`)

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.OK)
    expect(response.body).toEqual({selectedOrganizationId: null})
    expect(response.headers.etag).toBe(
      createSessionTag(configProvider.jwtConfig.secret, requestingAccount.id, requestingSessionId, 0n)
    )
  })

  it("rejects a missing CLI organization ID without changing the session", async () => {
    // Given: The helper creates the requesting account and a session owned by that account.
    const {sessionId: requestingSessionId, token: requestingToken} = await createPlatformSessionInDb(
      prisma,
      jwtService,
      configProvider
    )
    // Use CLI transport because the helper defaults to a browser session.
    const storedSession = await prisma.browserSession.update({
      where: {id: requestingSessionId},
      data: {transport: "cli"}
    })

    // When
    const response = await request(app.getHttpServer())
      .post("/auth/cli/select-organization")
      .set("Authorization", `Bearer ${requestingToken}`)
      .send({})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    expect(response.body).toHaveErrorCode("INVALID_ORGANIZATION")
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: requestingSessionId}})).toEqual(storedSession)
  })

  it("rejects a UUIDv4 CLI organization ID without changing the session", async () => {
    // Given: The helper creates the requesting account and a session owned by that account.
    const {sessionId: requestingSessionId, token: requestingToken} = await createPlatformSessionInDb(
      prisma,
      jwtService,
      configProvider
    )
    // Use CLI transport because the helper defaults to a browser session.
    const storedSession = await prisma.browserSession.update({
      where: {id: requestingSessionId},
      data: {transport: "cli"}
    })

    // When
    const response = await request(app.getHttpServer())
      .post("/auth/cli/select-organization")
      .set("Authorization", `Bearer ${requestingToken}`)
      .send({organizationId: uuidv4()})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    expect(response.body).toHaveErrorCode("INVALID_ORGANIZATION")
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: requestingSessionId}})).toEqual(storedSession)
  })

  it("rejects a non-string CLI organization ID without changing the session", async () => {
    // Given: The helper creates the requesting account and a session owned by that account.
    const {sessionId: requestingSessionId, token: requestingToken} = await createPlatformSessionInDb(
      prisma,
      jwtService,
      configProvider
    )
    // Use CLI transport because the helper defaults to a browser session.
    const storedSession = await prisma.browserSession.update({
      where: {id: requestingSessionId},
      data: {transport: "cli"}
    })

    // When
    const response = await request(app.getHttpServer())
      .post("/auth/cli/select-organization")
      .set("Authorization", `Bearer ${requestingToken}`)
      .send({organizationId: 42})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    expect(response.body).toHaveErrorCode("INVALID_ORGANIZATION")
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: requestingSessionId}})).toEqual(storedSession)
  })

  it("rejects a malformed CLI organization ID without changing the session", async () => {
    // Given: The helper creates the requesting account and a session owned by that account.
    const {sessionId: requestingSessionId, token: requestingToken} = await createPlatformSessionInDb(
      prisma,
      jwtService,
      configProvider
    )
    // Use CLI transport because the helper defaults to a browser session.
    const storedSession = await prisma.browserSession.update({
      where: {id: requestingSessionId},
      data: {transport: "cli"}
    })

    // When
    const response = await request(app.getHttpServer())
      .post("/auth/cli/select-organization")
      .set("Authorization", `Bearer ${requestingToken}`)
      .send({organizationId: "invalid"})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    expect(response.body).toHaveErrorCode("INVALID_ORGANIZATION")
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: requestingSessionId}})).toEqual(storedSession)
  })

  it("rejects CLI organization selection when the account has no membership", async () => {
    // Given: The helper creates a requesting account and a session owned by that account.
    // The owner created in beforeEach belongs to a separate account and organization.
    const {
      account: requestingAccount,
      sessionId: requestingSessionId,
      token: requestingToken
    } = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    // The helper creates a browser session. Use CLI transport so this request reaches
    // the membership check instead of failing because the session has the wrong transport.
    const storedSession = await prisma.browserSession.update({
      where: {id: requestingSessionId},
      data: {transport: "cli"}
    })

    expect(storedSession.accountId).toBe(requestingAccount.id)
    expect(requestingAccount.id).not.toBe(owner.user.accountId)

    // The owner's organization exists, but the requesting account has no membership in it.
    expect(
      await prisma.user.count({
        where: {organizationId: owner.user.organizationId, platformAccountId: requestingAccount.id}
      })
    ).toBe(0)

    // When: The account tries to select the owner's organization without being a member.
    const response = await request(app.getHttpServer())
      .post("/auth/cli/select-organization")
      .set("Authorization", `Bearer ${requestingToken}`)
      .send({organizationId: owner.user.organizationId})

    // Expect: Authentication succeeds, but organization access is denied. The rejected
    // selection must leave the session's selected organization and version unchanged.
    expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
    expect(response.body).toHaveErrorCode("PERMISSION_DENIED")
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: requestingSessionId}})).toEqual(storedSession)
  })

  it("rejects CLI organization selection when another update changes the session version", async () => {
    // Given: A CLI account with membership in the target organization, so selection is authorized.
    const {
      account: requestingAccount,
      sessionId: requestingSessionId,
      token: requestingToken
    } = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    const storedSession = await prisma.browserSession.update({
      where: {id: requestingSessionId},
      data: {transport: "cli"}
    })
    await createMockUserInDb(prisma, {
      organizationId: owner.user.organizationId,
      platformAccountId: requestingAccount.id
    })

    // After selection reads the session version and checks membership, simulate another
    // writer advancing that version. The real switchContext must reject the stale version.
    wrapTaskEitherWithSideEffect(
      app.get<MembershipRepository>(MEMBERSHIP_REPOSITORY_TOKEN),
      "getByAccount",
      async () => {
        await prisma.browserSession.update({
          where: {id: requestingSessionId},
          data: {occ: {increment: 1}}
        })
      }
    )

    // When: Select the organization using a session changed by the competing writer.
    const response = await request(app.getHttpServer())
      .post("/auth/cli/select-organization")
      .set("Authorization", `Bearer ${requestingToken}`)
      .send({organizationId: owner.user.organizationId})

    // Expect: The real database version check reports a conflict. Only the competing
    // writer's version increment persists; selection and token issuance do not occur.
    expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
    expect(response.body).toHaveErrorCode("ORGANIZATION_CONTEXT_CHANGED")
    expect(response.body.accessToken).toBeUndefined()
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: requestingSessionId}})).toEqual({
      ...storedSession,
      occ: storedSession.occ + 1n
    })
  })

  it("rejects a token using another account's browser session", async () => {
    // Given: Two different accounts, each with its own session.
    const tokenAccountSession = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    const otherAccountSession = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    // Sign a token for the first account that incorrectly references the other account's session.
    const token = jwtService.sign(
      TokenPayloadBuilder.fromPlatformAccount(tokenAccountSession.account, {
        issuer: configProvider.jwtConfig.issuer,
        audience: [configProvider.jwtConfig.audience],
        providerId: otherAccountSession.providerId,
        sessionId: otherAccountSession.sessionId,
        sessionContextVersion: 0n
      })
    )

    // When
    const response = await request(app.getHttpServer()).get("/auth/web/session").set("Authorization", `Bearer ${token}`)

    // Expect: Session ownership validation rejects the mismatched account and session IDs.
    expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
    expect(response.body).toHaveErrorCode("INVALID_SESSION")
  })

  it("allows only one concurrent organization switch for the same session version", async () => {
    // Given: The helper creates the requesting account and a session owned by that account.
    const {
      account: requestingAccount,
      sessionId: requestingSessionId,
      token: requestingToken
    } = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    // Creating both organizations gives this same account membership in each.
    const firstOrganizationResponse = await request(app.getHttpServer())
      .post("/organizations")
      .set("Authorization", `Bearer ${requestingToken}`)
      .send({slug: `switch-first-${requestingAccount.id}`, displayName: "First"})
      .expect(HttpStatus.CREATED)
    const secondOrganizationResponse = await request(app.getHttpServer())
      .post("/organizations")
      .set("Authorization", `Bearer ${requestingToken}`)
      .send({slug: `switch-second-${requestingAccount.id}`, displayName: "Second"})
      .expect(HttpStatus.CREATED)
    const etag = createSessionTag(configProvider.jwtConfig.secret, requestingAccount.id, requestingSessionId, 0n)
    const switchTo = (organizationId: string) =>
      request(app.getHttpServer())
        .post("/auth/web/select-organization")
        .set("Authorization", `Bearer ${requestingToken}`)
        .set("If-Match", etag)
        .send({organizationId})

    // When: The same account submits two switches with the same session version.
    const responses = await Promise.all([
      switchTo(firstOrganizationResponse.body.organization.id),
      switchTo(secondOrganizationResponse.body.organization.id)
    ])

    // Expect: Exactly one switch wins; the stored context belongs to that winning organization.
    expect(responses.filter(response => response.status === Number(HttpStatus.CREATED))).toHaveLength(1)
    const failure = responses.find(response => response.status !== Number(HttpStatus.CREATED))
    expect([HttpStatus.UNAUTHORIZED, HttpStatus.PRECONDITION_FAILED]).toContain(failure?.status)
    const persisted = await prisma.browserSession.findUniqueOrThrow({where: {id: requestingSessionId}})
    expect(persisted).toMatchObject({occ: 1n, contextVersion: 1n})
    expect([firstOrganizationResponse.body.organization.id, secondOrganizationResponse.body.organization.id]).toContain(
      persisted.selectedOrganizationId
    )
  })

  it("rejects a signed platform token for an account that does not exist", async () => {
    // Given: The helper creates the requesting account and a session owned by that account.
    const {
      account: requestingAccount,
      sessionId: requestingSessionId,
      providerId: requestingProviderId
    } = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    const account = unwrapRight(AccountFactory.validate({...requestingAccount, id: uuidv7()}))
    const token = jwtService.sign(
      TokenPayloadBuilder.fromPlatformAccount(account, {
        issuer: configProvider.jwtConfig.issuer,
        audience: [configProvider.jwtConfig.audience],
        providerId: requestingProviderId,
        sessionId: requestingSessionId,
        sessionContextVersion: 0n
      })
    )

    // When
    const response = await request(app.getHttpServer()).get("/auth/web/session").set("Authorization", `Bearer ${token}`)

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
    expect(response.body).toHaveErrorCode("ACCOUNT_NOT_FOUND")
  })

  it("rejects a signed tenant token whose account no longer exists", async () => {
    // Given: Use the persisted session belonging to the owner account.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    const user = unwrapRight(UserFactory.validate({...owner.user, accountId: uuidv7()}))
    const token = TestTokenBuilder.signUserToken(jwtService, configProvider, user, {
      providerId: ownerSession.providerId,
      sessionId: ownerSession.id,
      contextVersion: ownerSession.contextVersion
    })

    // When
    const response = await request(app.getHttpServer()).get(endpoint).set("Authorization", `Bearer ${token}`)

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)

    expect(response.body).toHaveErrorCode("ACCOUNT_NOT_FOUND")
  })

  it("returns the incremented session ETag and an access cookie with the signed JWT's lifetime", async () => {
    // Given: Use the persisted session belonging to the owner account.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    const initialContext = await request(app.getHttpServer())
      .get("/auth/web/session")
      .set("Authorization", `Bearer ${owner.token}`)
    expect(initialContext).toHaveStatusCode(HttpStatus.OK)
    const initialETag = initialContext.headers.etag
    if (typeof initialETag !== "string") throw new Error("Session response omitted its ETag")

    // When: Select the organization using the session version returned by GET.
    const response = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", initialETag)
      .send({organizationId: owner.user.organizationId})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.CREATED)
    expect(response.body).toEqual({selectedOrganizationId: owner.user.organizationId})
    const cookie = getAccessCookie(response.headers["set-cookie"])
    const refreshedAccessToken = accessTokenFromCookie(cookie)
    const claims = jwtService.verify<{iat: number; exp: number; sessionContextVersion: string}>(refreshedAccessToken)
    expect(Number(cookie.match(/Max-Age=(\d+)/)?.[1])).toBe(claims.exp - claims.iat)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(claims.sessionContextVersion).toBe((ownerSession.contextVersion + 1n).toString())
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toMatchObject({
      occ: ownerSession.occ + 1n,
      contextVersion: ownerSession.contextVersion + 1n
    })

    // When: Read the session with the fresh token issued by the selection.
    const currentContext = await request(app.getHttpServer())
      .get("/auth/web/session")
      .set("Authorization", `Bearer ${refreshedAccessToken}`)

    // Expect: GET agrees with POST on the selected organization and its new session ETag.
    expect(currentContext).toHaveStatusCode(HttpStatus.OK)
    expect(currentContext.body).toEqual(response.body)
    expect(currentContext.headers.etag).toEqual(expect.any(String))
    expect(currentContext.headers.etag).toBe(response.headers.etag)
    expect(currentContext.headers.etag).not.toBe(initialETag)
  })

  it("rejects a malformed switch body: missing organization ID", async () => {
    // Given: Use the persisted session belonging to the owner account.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})

    // When
    const response = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    expect(response.body).toHaveErrorCode("INVALID_ORGANIZATION")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toEqual(ownerSession)
  })

  it("rejects a UUIDv4 organization without changing the session", async () => {
    // Given: Use the persisted session belonging to the owner account.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    const etag = createSessionTag(
      configProvider.jwtConfig.secret,
      ownerSession.accountId,
      ownerSession.id,
      ownerSession.occ
    )

    // When
    const response = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({organizationId: uuidv4()})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    expect(response.body).toHaveErrorCode("INVALID_ORGANIZATION")
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toEqual(ownerSession)
  })

  it("rejects a malformed switch body: non-string organization ID", async () => {
    // Given: Use the persisted session belonging to the owner account.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})

    // When
    const response = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({organizationId: 42})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    expect(response.body).toHaveErrorCode("INVALID_ORGANIZATION")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toEqual(ownerSession)
  })

  it("rejects a malformed switch body: malformed organization ID", async () => {
    // Given: Use the persisted session belonging to the owner account.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})

    // When
    const response = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({organizationId: "invalid"})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    expect(response.body).toHaveErrorCode("INVALID_ORGANIZATION")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toEqual(ownerSession)
  })

  it("rejects a switch without If-Match and preserves the session", async () => {
    // Given: Use the persisted session belonging to the owner account.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})

    // When
    const response = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({organizationId: owner.user.organizationId})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.PRECONDITION_FAILED)
    expect(response.body).toHaveErrorCode("INVALID_ETAG")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toEqual(ownerSession)
  })

  it("rejects an ETag bound to another account and session", async () => {
    // Given: Use the persisted session belonging to the owner account.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    const other = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    const etag = createSessionTag(configProvider.jwtConfig.secret, other.account.id, other.sessionId, 0n)

    // When
    const response = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({organizationId: owner.user.organizationId})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.PRECONDITION_FAILED)
    expect(response.body).toHaveErrorCode("INVALID_ETAG")
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toEqual(ownerSession)
  })

  it("rejects a stale session ETag even when the access token has the current context", async () => {
    // Given: Use the persisted session belonging to the owner account.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    const etag = createSessionTag(
      configProvider.jwtConfig.secret,
      ownerSession.accountId,
      ownerSession.id,
      ownerSession.occ
    )
    const switched = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({organizationId: owner.user.organizationId})
      .expect(HttpStatus.CREATED)
    const token = accessTokenFromCookie(getAccessCookie(switched.headers["set-cookie"]))

    // When
    const response = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${token}`)
      .set("If-Match", etag)
      .send({organizationId: owner.user.organizationId})

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.PRECONDITION_FAILED)
    expect(response.body).toHaveErrorCode("INVALID_ETAG")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toMatchObject({
      occ: ownerSession.occ + 1n
    })
  })

  it("rejects reading the web session after it has been revoked", async () => {
    // Given: The owner's signed token still refers to a session that has been revoked in the database.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    const revokedSession = await prisma.browserSession.update({
      where: {id: ownerSession.id},
      data: {status: "revoked", occ: {increment: 1}}
    })

    // When: Read the session using the token issued before revocation.
    const response = await request(app.getHttpServer())
      .get("/auth/web/session")
      .set("Authorization", `Bearer ${owner.token}`)

    // Expect: Persisted session validity overrides the token's valid signature.
    expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
    expect(response.body).toHaveErrorCode("INVALID_SESSION")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toEqual(revokedSession)
  })

  it("rejects reading the web session with the token superseded by organization selection", async () => {
    // Given: Read the current session version through the API.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    const initialContext = await request(app.getHttpServer())
      .get("/auth/web/session")
      .set("Authorization", `Bearer ${owner.token}`)
    expect(initialContext).toHaveStatusCode(HttpStatus.OK)
    const initialETag = initialContext.headers.etag
    if (typeof initialETag !== "string") throw new Error("Session response omitted its ETag")

    // Organization selection advances the context version and issues a replacement token.
    const selection = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", initialETag)
      .send({organizationId: owner.user.organizationId})
    expect(selection).toHaveStatusCode(HttpStatus.CREATED)
    const selectedSession = await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})

    // When: Read the session using the old token instead of the replacement token.
    const response = await request(app.getHttpServer())
      .get("/auth/web/session")
      .set("Authorization", `Bearer ${owner.token}`)

    // Expect: The old token's context version is stale; the selected context remains unchanged.
    expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
    expect(response.body).toHaveErrorCode("ORGANIZATION_CONTEXT_CHANGED")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toEqual(selectedSession)
  })

  it("rejects a web organization switch when another update changes the session version", async () => {
    // Given: The owner has a valid session and membership in the target organization.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    const etag = createSessionTag(
      configProvider.jwtConfig.secret,
      ownerSession.accountId,
      ownerSession.id,
      ownerSession.occ
    )

    // Advance the stored version after membership lookup but before switchContext.
    // The request's If-Match version becomes stale while the real request is running.
    wrapTaskEitherWithSideEffect(
      app.get<MembershipRepository>(MEMBERSHIP_REPOSITORY_TOKEN),
      "getByAccount",
      async () => {
        await prisma.browserSession.update({
          where: {id: ownerSession.id},
          data: {occ: {increment: 1}}
        })
      }
    )

    // When: Switch organizations using the version from before the competing update.
    const response = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", etag)
      .send({organizationId: owner.user.organizationId})

    // Expect: The real version check rejects the switch without issuing a cookie.
    // Only the competing writer's version increment persists.
    expect(response).toHaveStatusCode(HttpStatus.PRECONDITION_FAILED)
    expect(response.body).toHaveErrorCode("INVALID_ETAG")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toEqual({
      ...ownerSession,
      occ: ownerSession.occ + 1n
    })
  })

  it("rejects web organization selection when the requesting account has no membership", async () => {
    // Given: A separate requesting account owns this valid browser session.
    const {
      account: requestingAccount,
      sessionId: requestingSessionId,
      token: requestingToken
    } = await createPlatformSessionInDb(prisma, jwtService, configProvider)
    const storedSession = await prisma.browserSession.findUniqueOrThrow({where: {id: requestingSessionId}})
    expect(storedSession.accountId).toBe(requestingAccount.id)
    expect(requestingAccount.id).not.toBe(owner.user.accountId)
    expect(
      await prisma.user.count({
        where: {organizationId: owner.user.organizationId, platformAccountId: requestingAccount.id}
      })
    ).toBe(0)
    const initialContext = await request(app.getHttpServer())
      .get("/auth/web/session")
      .set("Authorization", `Bearer ${requestingToken}`)
    expect(initialContext).toHaveStatusCode(HttpStatus.OK)
    const initialETag = initialContext.headers.etag
    if (typeof initialETag !== "string") throw new Error("Session response omitted its ETag")

    // When: Select the owner's existing organization, where this requesting account is not a member.
    const response = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${requestingToken}`)
      .set("If-Match", initialETag)
      .send({organizationId: owner.user.organizationId})

    // Expect: The real membership lookup denies selection without changing the session or issuing a cookie.
    expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
    expect(response.body).toHaveErrorCode("PERMISSION_DENIED")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: requestingSessionId}})).toEqual(storedSession)
  })

  it("rejects web organization selection after the requesting session has been revoked", async () => {
    // Given: The owner is a member of the target organization and obtains the current session ETag.
    const ownerSession = await prisma.browserSession.findFirstOrThrow({where: {accountId: owner.user.accountId}})
    const initialContext = await request(app.getHttpServer())
      .get("/auth/web/session")
      .set("Authorization", `Bearer ${owner.token}`)
    expect(initialContext).toHaveStatusCode(HttpStatus.OK)
    const initialETag = initialContext.headers.etag
    if (typeof initialETag !== "string") throw new Error("Session response omitted its ETag")

    // Revocation invalidates the session even though the existing access token is still signed and unexpired.
    const revokedSession = await prisma.browserSession.update({
      where: {id: ownerSession.id},
      data: {status: "revoked", occ: {increment: 1}}
    })

    // When: Attempt selection using the token and ETag obtained before revocation.
    const response = await request(app.getHttpServer())
      .post("/auth/web/select-organization")
      .set("Authorization", `Bearer ${owner.token}`)
      .set("If-Match", initialETag)
      .send({organizationId: owner.user.organizationId})

    // Expect: Authentication rejects the revoked session before selection can change it or issue a cookie.
    expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
    expect(response.body).toHaveErrorCode("INVALID_SESSION")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(await prisma.browserSession.findUniqueOrThrow({where: {id: ownerSession.id}})).toEqual(revokedSession)
  })
})

function getAccessCookie(cookies: unknown): string {
  if (!Array.isArray(cookies)) throw new Error("Response omitted its cookies")
  const cookie = cookies.find(
    (value: unknown): value is string => typeof value === "string" && value.startsWith("access_token=")
  )
  if (typeof cookie !== "string") throw new Error("Response omitted its access token cookie")
  return cookie
}

function accessTokenFromCookie(cookie: string): string {
  const token = cookie.match(/^access_token=([^;]+)/)?.[1]
  if (!token) throw new Error("Access token cookie is empty")
  return decodeURIComponent(token)
}
