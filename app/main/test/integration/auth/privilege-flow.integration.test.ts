import {randomOrgId, toOrganizationId} from "@test/organization-id"
import * as E from "fp-ts/Either"
import {Test, TestingModule} from "@nestjs/testing"
import {INestApplication} from "@nestjs/common"
import request from "supertest"
import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider, createMockUserInDb} from "@test/mock-data"
import {PrismaClient} from "@prisma/client"
import "@utils/matchers"
import {simulateOidcAuthorization, OidcMockUser} from "@test/oidc-test-helpers"
import "expect-more-jest"
import {AuthService} from "@services"
import {JwtService} from "@nestjs/jwt"
import {AuthenticatedUser, AuthenticatedAgent, MembershipStatus, OrgRole} from "@domain"
import {OidcBootstrapService} from "@external/oidc/oidc-bootstrap.service"

const organizationId = randomOrgId()

describe("Privilege Flow Integration", () => {
  let app: INestApplication
  let prisma: PrismaClient
  let testUser: OidcMockUser
  let configProvider: ConfigProvider
  let authService: AuthService
  let jwtService: JwtService

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    // Create test user data for real OIDC server creation
    const username = "privilege-test-user"
    const userEmail = "privilege@localhost.com"
    const displayName = "Privilege User"

    testUser = {
      SubjectId: username,
      Username: username,
      Password: "privilege-password",
      Claims: [
        {Type: "name", Value: displayName},
        {Type: "email", Value: userEmail},
        {Type: "email_verified", Value: "true"}
      ]
    }

    const mockConfigProvider = MockConfigProvider.fromTenantConnectionUrl(isolatedDb)
    const customProvider = mockConfigProvider.oidcProviders.get("custom")
    if (!customProvider) throw new Error("Custom OIDC provider not found")
    customProvider.provider = "auth0" // Must be supported provider for step-up auth

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(mockConfigProvider)
      .compile()

    app = module.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(isolatedDb)
    configProvider = module.get(ConfigProvider)
    authService = module.get(AuthService)
    jwtService = module.get(JwtService)

    await app.init()
  }, 20000)

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  beforeEach(async () => {
    await createMockUserInDb(prisma, {
      displayName: "Privilege User",
      email: "privilege@localhost.com",
      organizationId,
      identity: {providerId: "custom", subjectId: testUser.SubjectId}
    })
  })

  const authenticateCliUser = async (): Promise<{accessToken: string; refreshToken: string}> => {
    const initiation = await request(app.getHttpServer())
      .post("/auth/cli/initiate")
      .send({redirectUri: "http://127.0.0.1:8080/callback", provider: "custom"})
      .expect(200)
    const state = new URL(initiation.body.authorizationUrl).searchParams.get("state")
    if (!state) throw new Error("CLI authorization state not found")

    const code = await simulateOidcAuthorization(initiation.body.authorizationUrl, testUser, configProvider)
    const platformToken = await request(app.getHttpServer()).post("/auth/cli/token").send({code, state}).expect(201)
    const organizationToken = await request(app.getHttpServer())
      .post("/auth/cli/select-organization")
      .set("Authorization", `Bearer ${platformToken.body.accessToken}`)
      .send({organizationId})
      .expect(200)
    return organizationToken.body
  }

  describe("Complete Privilege Token Flow", () => {
    it("rejects a step-up without a resource", async () => {
      // Given: An authenticated user initiates step-up
      const {accessToken} = await authenticateCliUser()
      const initiation = await request(app.getHttpServer())
        .get("/auth/cli/initiatePrivilegedTokenExchange")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(302)
      const location = initiation.headers.location
      if (typeof location !== "string") throw new Error("Privilege location not found")
      const state = new URL(location).searchParams.get("state")
      if (!state) throw new Error("Privilege state not found")

      // When: Exchange the step-up code without a resource
      const code = await simulateOidcAuthorization(location, testUser, configProvider)
      const exchangeResponse = await request(app.getHttpServer())
        .post("/auth/cli/exchangePrivilegedToken")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({code, state, operation: "admin_action"})

      // Expect: The request is rejected without creating a receipt
      expect(exchangeResponse).toHaveStatusCode(400)
      expect(exchangeResponse.body).toHaveErrorCode("REQUEST_MISSING_RESOURCE_ID")
      expect(await prisma.stepUpReceipt.count({where: {organizationId}})).toBe(0)
    }, 40000)

    it("should successfully complete step-up auth and enforce single-use", async () => {
      // 1. Given: Initial login provides a standard access token
      const {accessToken: standardAccessToken} = await authenticateCliUser()
      expect(standardAccessToken).toBeTruthy()

      // 2. When: Initiate privilege token exchange
      const initiateResponse = await request(app.getHttpServer())
        .get("/auth/cli/initiatePrivilegedTokenExchange")
        .set("Authorization", `Bearer ${standardAccessToken}`)
        .expect(302)

      const privilegeLocation = initiateResponse.headers.location
      const privilegeStateMatch = privilegeLocation?.match(/state=([^&]+)/)
      const privilegeState = privilegeStateMatch ? privilegeStateMatch[1] : null
      expect(privilegeState).toBeTruthy()

      if (!privilegeLocation) throw new Error("Privilege location not found")

      // 3. When: Re-authenticate at the IdP for step-up
      const privilegeCode = await simulateOidcAuthorization(privilegeLocation, testUser, configProvider)

      // 4. When: Exchange the code for a privilege token
      const targetOperation = "vote"
      const targetResource = organizationId

      const exchangeResponse = await request(app.getHttpServer())
        .post("/auth/cli/exchangePrivilegedToken")
        .set("Authorization", `Bearer ${standardAccessToken}`)
        .send({
          code: privilegeCode,
          state: privilegeState,
          operation: targetOperation,
          resourceId: targetResource
        })
        .expect(200)

      const privilegeToken = exchangeResponse.body.accessToken
      expect(privilegeToken).toBeTruthy()

      // Expect: The token contains the requested step-up context
      const decodedToken = jwtService.decode(privilegeToken)
      expect(decodedToken.operation).toBe(targetOperation)
      expect(decodedToken.resource).toBe(targetResource)
      expect(decodedToken.jti).toBeTruthy() // Context must have a JTI

      // 5. Expect: The privilege token authenticates against its selected organization
      await request(app.getHttpServer())
        .get(`/o/${organizationId}/auth/info`)
        .set("Authorization", `Bearer ${privilegeToken}`)
        .expect(200)

      // 6. Given: An authenticated user with the single-use privilege context
      const authenticatedEntity: AuthenticatedUser = {
        entityType: "user" as const,
        providerId: decodedToken.providerId as string,
        user: {
          id: decodedToken.sub as string,
          organizationId: toOrganizationId(
            (await prisma.user.findUniqueOrThrow({where: {id: decodedToken.sub as string}})).organizationId
          ),
          accountId: (await prisma.user.findUniqueOrThrow({where: {id: decodedToken.sub as string}})).platformAccountId,
          displayName: "Privilege User",
          createdAt: new Date(),
          updatedAt: new Date(),
          status: MembershipStatus.ACTIVE,
          orgRole: OrgRole.MEMBER,
          roles: []
        },
        sessionId: decodedToken.sessionId as string,
        sessionContextVersion: BigInt(decodedToken.sessionContextVersion as string),
        authContext: {
          operation: targetOperation,
          resource: targetResource,
          jti: decodedToken.jti as string
        }
      }

      // Given: The step-up receipt has expired
      const receiptWhere = {organizationId_jti: {organizationId, jti: decodedToken.jti as string}}
      await prisma.stepUpReceipt.update({
        where: receiptWhere,
        data: {expiresAt: new Date(Date.now() - 1000)}
      })
      // Expect: An expired receipt is rejected and remains unconsumed
      expect(
        await authService.useHighPrivilegeToken(authenticatedEntity, targetOperation, targetResource)()
      ).toBeLeftOf("invalid_credential")
      expect((await prisma.stepUpReceipt.findUniqueOrThrow({where: receiptWhere})).consumedAt).toBeNull()
      // Given: The receipt is valid again
      await prisma.stepUpReceipt.update({
        where: receiptWhere,
        data: {expiresAt: new Date(Date.now() + 60_000)}
      })

      // When: Attempt to consume the valid receipt concurrently
      const uses = await Promise.all([
        authService.useHighPrivilegeToken(authenticatedEntity, targetOperation, targetResource)(),
        authService.useHighPrivilegeToken(authenticatedEntity, targetOperation, targetResource)()
      ])

      // Expect: Exactly one concurrent use consumes the receipt
      expect(uses.filter(result => E.isRight(result))).toHaveLength(1)
      expect(uses.filter(result => E.isLeft(result))).toEqual([E.left("invalid_credential")])
      expect((await prisma.stepUpReceipt.findUniqueOrThrow({where: receiptWhere})).consumedAt).toBeInstanceOf(Date)

      // When: Attempt to reuse the consumed receipt
      const secondUseResult = await authService.useHighPrivilegeToken(
        authenticatedEntity,
        targetOperation,
        targetResource
      )()

      // Expect: A consumed receipt cannot be reused
      expect(secondUseResult).toBeLeftOf("invalid_credential")
    }, 40000)

    describe("cross-provider step-up", () => {
      beforeEach(async () => {
        configProvider.oidcProviders.set("okta", {
          provider: "custom",
          issuerUrl: "http://localhost:4011",
          clientId: "integration-test-client-id",
          clientSecret: "integration-test-client-secret",
          redirectUri: "http://localhost:3000/auth/web/callback",
          displayName: "Okta",
          allowInsecure: true
        })
        const oidcBootstrap = app.get(OidcBootstrapService)
        await oidcBootstrap.onApplicationBootstrap()
      })

      afterEach(async () => {
        configProvider.oidcProviders.delete("okta")
        const oidcBootstrap = app.get(OidcBootstrapService)
        await oidcBootstrap.onApplicationBootstrap()
      })

      it("should reject cross-provider step-up when step-up uses different provider than active session", async () => {
        // 1. Given: Initial login provides a standard access token
        const {accessToken: standardAccessToken} = await authenticateCliUser()
        expect(standardAccessToken).toBeTruthy()

        // 2. When: Initiate step-up explicitly requesting the second provider ("okta")
        const initiateResponse = await request(app.getHttpServer())
          .get("/auth/cli/initiatePrivilegedTokenExchange?provider=okta")
          .set("Authorization", `Bearer ${standardAccessToken}`)
          .expect(302)

        const privilegeLocation = initiateResponse.headers.location ?? ""
        const privilegeState = privilegeLocation.match(/state=([^&]+)/)?.[1] ?? ""

        const privilegeCode = await simulateOidcAuthorization(privilegeLocation, testUser, configProvider, "okta")

        // 3. When: Exchange the code from "okta" using the session bound to "custom"
        const exchangeResponse = await request(app.getHttpServer())
          .post("/auth/cli/exchangePrivilegedToken")
          .set("Authorization", `Bearer ${standardAccessToken}`)
          .send({
            code: privilegeCode,
            state: privilegeState,
            operation: "vote",
            resourceId: organizationId
          })

        // Expect: Cross-provider step-up is rejected
        expect(exchangeResponse).toHaveStatusCode(400)
        expect(exchangeResponse.body).toHaveErrorCode("AUTH_IDENTITY_CONFLICT")
      }, 40000)
    })

    it("should reject step-up when IdP credentials belong to a different user identity (account swapping defense)", async () => {
      // 1. Given: User 1 logs in
      const {accessToken: user1AccessToken} = await authenticateCliUser()
      expect(user1AccessToken).toBeTruthy()

      // 2. Given: A second distinct user in the database and IdP
      const otherUser: OidcMockUser = {
        SubjectId: "other-user-subject",
        Username: "other-user-subject",
        Password: "other-password",
        Claims: [
          {Type: "name", Value: "Other User"},
          {Type: "email", Value: "other@localhost.com"},
          {Type: "email_verified", Value: "true"}
        ]
      }

      await createMockUserInDb(prisma, {
        displayName: "Other User",
        email: "other@localhost.com",
        organizationId,
        identity: {
          providerId: "custom",
          subjectId: otherUser.SubjectId
        }
      })

      // 3. When: User 1 initiates step-up
      const initiateResponse = await request(app.getHttpServer())
        .get("/auth/cli/initiatePrivilegedTokenExchange")
        .set("Authorization", `Bearer ${user1AccessToken}`)
        .expect(302)

      const privilegeLocation = initiateResponse.headers.location ?? ""
      const privilegeState = privilegeLocation.match(/state=([^&]+)/)?.[1] ?? ""

      // 4. When: A different user authorizes at the IdP with their own credentials
      const privilegeCodeFromOtherUser = await simulateOidcAuthorization(privilegeLocation, otherUser, configProvider)

      // 5. When: User 1 exchanges the code from the other user
      // Expect: Identity ownership verification rejects the account swap
      const exchangeResponse = await request(app.getHttpServer())
        .post("/auth/cli/exchangePrivilegedToken")
        .set("Authorization", `Bearer ${user1AccessToken}`)
        .send({
          code: privilegeCodeFromOtherUser,
          state: privilegeState,
          operation: "vote",
          resourceId: organizationId
        })

      expect(exchangeResponse).toHaveStatusCode(400)
      expect(exchangeResponse.body).toHaveErrorCode("AUTH_IDENTITY_CONFLICT")
    }, 40000)

    it("should preserve configured provider ID across token refreshes and allow subsequent step-up", async () => {
      // 1. Given: Initial login provides access and refresh tokens
      const {accessToken: initialAccessToken, refreshToken} = await authenticateCliUser()
      expect(initialAccessToken).toBeTruthy()
      expect(refreshToken).toBeTruthy()

      // 2. When: Refresh the token via the CLI refresh endpoint
      const refreshResponse = await request(app.getHttpServer())
        .post("/auth/cli/refresh")
        .send({refreshToken})
        .expect(200)

      const refreshedAccessToken = refreshResponse.body.accessToken
      expect(refreshedAccessToken).toBeTruthy()

      // Expect: The refreshed access token preserves the configured provider ID
      const decodedRefreshed = jwtService.decode(refreshedAccessToken)
      expect(decodedRefreshed.providerId).toBe(jwtService.decode(initialAccessToken).providerId)
      expect(decodedRefreshed.email).toBe("privilege@localhost.com")

      // 3. When: Initiate step-up using the refreshed access token
      const initiateResponse = await request(app.getHttpServer())
        .get("/auth/cli/initiatePrivilegedTokenExchange")
        .set("Authorization", `Bearer ${refreshedAccessToken}`)
        .expect(302)

      const privilegeLocation = initiateResponse.headers.location ?? ""
      const privilegeState = privilegeLocation.match(/state=([^&]+)/)?.[1] ?? ""

      // 4. When: Authorize at the IdP and exchange the code
      const privilegeCode = await simulateOidcAuthorization(privilegeLocation, testUser, configProvider)
      const exchangeResponse = await request(app.getHttpServer())
        .post("/auth/cli/exchangePrivilegedToken")
        .set("Authorization", `Bearer ${refreshedAccessToken}`)
        .send({
          code: privilegeCode,
          state: privilegeState,
          operation: "vote",
          resourceId: organizationId
        })
        .expect(200)

      // Expect: Step-up succeeds after refresh
      expect(exchangeResponse.body.accessToken).toBeTruthy()
    }, 40000)

    it("should reject web privilege token initiation for agent entities", async () => {
      // Given: An authenticated agent
      const agentEntity: AuthenticatedAgent = {
        entityType: "agent",
        agent: {
          id: "12345678-1234-7123-8123-123456789012",
          organizationId: toOrganizationId("12345678-1234-7123-8123-123456789012"),
          agentName: "test-service-agent",
          publicKey: "test-public-key",
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
          roles: []
        }
      }

      // When: The agent initiates web step-up
      const result = await authService.initiatePrivilegeTokenGenerationForWeb(agentEntity)()
      // Expect: Step-up rejects agent entities
      expect(result).toBeLeftOf("auth_invalid_entity")
    })
  })
})
