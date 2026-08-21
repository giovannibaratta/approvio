import {Test, TestingModule} from "@nestjs/testing"
import {INestApplication} from "@nestjs/common"
import request from "supertest"
import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {DatabaseClient} from "@external/database"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider, createMockUserInDb} from "@test/mock-data"
import {PrismaClient} from "@prisma/client"
import "@utils/matchers"
import {simulateOidcAuthorization, OidcMockUser} from "@test/oidc-test-helpers"
import "expect-more-jest"
import {AuthService} from "@services"
import {JwtService} from "@nestjs/jwt"
import {AuthenticatedUser, AuthenticatedAgent, OrgRole} from "@domain"
import {OidcBootstrapService} from "@external/oidc/oidc-bootstrap.service"

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

    const mockConfigProvider = MockConfigProvider.fromDbConnectionUrl(isolatedDb)
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
    prisma = module.get(DatabaseClient).prisma
    configProvider = module.get(ConfigProvider)
    authService = module.get(AuthService)
    jwtService = module.get(JwtService)

    // Create database user with email that matches OIDC user claims and identity link
    await createMockUserInDb(prisma, {
      displayName,
      email: userEmail,
      identity: {
        providerId: "custom",
        subjectId: testUser.SubjectId
      }
    })

    await app.init()
  }, 20000)

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  describe("Complete Privilege Token Flow", () => {
    it("should successfully complete step-up auth and enforce single-use", async () => {
      // 1. Initial Login to get a standard access token
      const loginResponse = await request(app.getHttpServer()).get("/auth/web/login").expect(302)
      const loginLocation = loginResponse.headers.location
      const loginStateMatch = loginLocation?.match(/state=([^&]+)/)
      const loginState = loginStateMatch ? loginStateMatch[1] : null
      expect(loginState).toBeTruthy()

      if (!loginLocation) throw new Error("Login location not found")

      const loginCode = await simulateOidcAuthorization(loginLocation, testUser, configProvider)

      const tokenResponse = await request(app.getHttpServer())
        .post("/auth/cli/token")
        .send({code: loginCode, state: loginState})
        .expect(201)

      const standardAccessToken = tokenResponse.body.accessToken
      expect(standardAccessToken).toBeTruthy()

      // 2. Initiate Privilege Token Exchange
      const initiateResponse = await request(app.getHttpServer())
        .get("/auth/cli/initiatePrivilegedTokenExchange")
        .set("Authorization", `Bearer ${standardAccessToken}`)
        .expect(302)

      const privilegeLocation = initiateResponse.headers.location
      const privilegeStateMatch = privilegeLocation?.match(/state=([^&]+)/)
      const privilegeState = privilegeStateMatch ? privilegeStateMatch[1] : null
      expect(privilegeState).toBeTruthy()

      if (!privilegeLocation) throw new Error("Privilege location not found")

      // 3. IDP Flow for Step-Up (simulate user re-authenticating)
      const privilegeCode = await simulateOidcAuthorization(privilegeLocation, testUser, configProvider)

      // 4. Exchange Code for Privilege Token
      const targetOperation = "vote"
      const targetResource = "test-resource-123"

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

      // Verify the token contains the step-up context
      const decodedToken = jwtService.decode(privilegeToken)
      expect(decodedToken.operation).toBe(targetOperation)
      expect(decodedToken.resource).toBe(targetResource)
      expect(decodedToken.jti).toBeTruthy() // Context must have a JTI

      // 5. Verify the token using /auth/info
      await request(app.getHttpServer()).get("/auth/info").set("Authorization", `Bearer ${privilegeToken}`).expect(200)

      // 6. Token Consumption (Single-use test) using AuthService
      const authenticatedEntity: AuthenticatedUser = {
        entityType: "user" as const,
        providerId: "custom",
        user: {
          id: decodedToken.sub as string,
          displayName: "Privilege User",
          email: "privilege@localhost.com",
          createdAt: new Date(),
          orgRole: OrgRole.MEMBER,
          roles: [],
          occ: 1n
        },
        authContext: {
          operation: targetOperation,
          resource: targetResource,
          jti: decodedToken.jti as string
        }
      }

      // First use should succeed
      const firstUseResult = await authService.useHighPrivilegeToken(
        authenticatedEntity,
        targetOperation,
        targetResource
      )()

      expect(firstUseResult).toBeRight()

      // Second use should fail
      const secondUseResult = await authService.useHighPrivilegeToken(
        authenticatedEntity,
        targetOperation,
        targetResource
      )()

      expect(secondUseResult).toBeLeftOf("token_not_found")
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
        // 1. Initial Login with primary provider ("custom")
        const loginResponse = await request(app.getHttpServer()).get("/auth/web/login?provider=custom").expect(302)
        const loginLocation = loginResponse.headers.location ?? ""
        const loginState = loginLocation.match(/state=([^&]+)/)?.[1] ?? ""

        const loginCode = await simulateOidcAuthorization(loginLocation, testUser, configProvider, "custom")

        const tokenResponse = await request(app.getHttpServer())
          .post("/auth/cli/token")
          .send({code: loginCode, state: loginState})
          .expect(201)

        const standardAccessToken = tokenResponse.body.accessToken
        expect(standardAccessToken).toBeTruthy()

        // 2. Initiate step-up explicitly requesting the second provider ("okta")
        const initiateResponse = await request(app.getHttpServer())
          .get("/auth/cli/initiatePrivilegedTokenExchange?provider=okta")
          .set("Authorization", `Bearer ${standardAccessToken}`)
          .expect(302)

        const privilegeLocation = initiateResponse.headers.location ?? ""
        const privilegeState = privilegeLocation.match(/state=([^&]+)/)?.[1] ?? ""

        const privilegeCode = await simulateOidcAuthorization(privilegeLocation, testUser, configProvider, "okta")

        // 3. Attempt to exchange token: Should fail because session is bound to "custom", not "okta"
        const exchangeResponse = await request(app.getHttpServer())
          .post("/auth/cli/exchangePrivilegedToken")
          .set("Authorization", `Bearer ${standardAccessToken}`)
          .send({
            code: privilegeCode,
            state: privilegeState,
            operation: "vote",
            resourceId: "test-resource-123"
          })

        expect(exchangeResponse).toHaveStatusCode(400)
        expect(exchangeResponse.body).toHaveErrorCode("AUTH_IDENTITY_CONFLICT")
      }, 40000)
    })

    it("should reject step-up when IdP credentials belong to a different user identity (account swapping defense)", async () => {
      // 1. User 1 logs in
      const loginResponse = await request(app.getHttpServer()).get("/auth/web/login").expect(302)
      const loginLocation = loginResponse.headers.location ?? ""
      const loginState = loginLocation.match(/state=([^&]+)/)?.[1] ?? ""

      const loginCode = await simulateOidcAuthorization(loginLocation, testUser, configProvider)
      const tokenResponse = await request(app.getHttpServer())
        .post("/auth/cli/token")
        .send({code: loginCode, state: loginState})
        .expect(201)

      const user1AccessToken = tokenResponse.body.accessToken
      expect(user1AccessToken).toBeTruthy()

      // 2. Setup a second distinct user in DB and IdP
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
        identity: {
          providerId: "custom",
          subjectId: otherUser.SubjectId
        }
      })

      // 3. User 1 initiates step-up
      const initiateResponse = await request(app.getHttpServer())
        .get("/auth/cli/initiatePrivilegedTokenExchange")
        .set("Authorization", `Bearer ${user1AccessToken}`)
        .expect(302)

      const privilegeLocation = initiateResponse.headers.location ?? ""
      const privilegeState = privilegeLocation.match(/state=([^&]+)/)?.[1] ?? ""

      // 4. An attacker / different user authorizes at IdP with otherUser credentials
      const privilegeCodeFromOtherUser = await simulateOidcAuthorization(privilegeLocation, otherUser, configProvider)

      // 5. User 1 attempts to exchange token using code from otherUser
      // This MUST be rejected by the security check verifying IdP subject matches requestor.user.id
      const exchangeResponse = await request(app.getHttpServer())
        .post("/auth/cli/exchangePrivilegedToken")
        .set("Authorization", `Bearer ${user1AccessToken}`)
        .send({
          code: privilegeCodeFromOtherUser,
          state: privilegeState,
          operation: "vote",
          resourceId: "test-resource-123"
        })

      expect(exchangeResponse).toHaveStatusCode(400)
      expect(exchangeResponse.body).toHaveErrorCode("AUTH_IDENTITY_CONFLICT")
    }, 40000)

    it("should preserve providerId across token refreshes and allow subsequent step-up", async () => {
      // 1. Initial Login
      const loginResponse = await request(app.getHttpServer()).get("/auth/web/login").expect(302)
      const loginLocation = loginResponse.headers.location ?? ""
      const loginState = loginLocation.match(/state=([^&]+)/)?.[1] ?? ""

      const loginCode = await simulateOidcAuthorization(loginLocation, testUser, configProvider)
      const tokenResponse = await request(app.getHttpServer())
        .post("/auth/cli/token")
        .send({code: loginCode, state: loginState})
        .expect(201)

      const initialAccessToken = tokenResponse.body.accessToken
      const refreshToken = tokenResponse.body.refreshToken
      expect(initialAccessToken).toBeTruthy()
      expect(refreshToken).toBeTruthy()

      // 2. Refresh token via CLI refresh endpoint
      const refreshResponse = await request(app.getHttpServer())
        .post("/auth/cli/refresh")
        .send({refreshToken})
        .expect(200)

      const refreshedAccessToken = refreshResponse.body.accessToken
      expect(refreshedAccessToken).toBeTruthy()

      // Verify the refreshed access token contains providerId
      const decodedRefreshed = jwtService.decode(refreshedAccessToken)
      expect(decodedRefreshed.providerId).toBe("custom")

      // 3. Initiate Step-Up using refreshed access token
      const initiateResponse = await request(app.getHttpServer())
        .get("/auth/cli/initiatePrivilegedTokenExchange")
        .set("Authorization", `Bearer ${refreshedAccessToken}`)
        .expect(302)

      const privilegeLocation = initiateResponse.headers.location ?? ""
      const privilegeState = privilegeLocation.match(/state=([^&]+)/)?.[1] ?? ""

      // 4. Authorize and exchange
      const privilegeCode = await simulateOidcAuthorization(privilegeLocation, testUser, configProvider)
      const exchangeResponse = await request(app.getHttpServer())
        .post("/auth/cli/exchangePrivilegedToken")
        .set("Authorization", `Bearer ${refreshedAccessToken}`)
        .send({
          code: privilegeCode,
          state: privilegeState,
          operation: "vote",
          resourceId: "test-resource-123"
        })
        .expect(200)

      expect(exchangeResponse.body.accessToken).toBeTruthy()
    }, 40000)

    it("should reject web privilege token initiation for agent entities", async () => {
      const agentEntity: AuthenticatedAgent = {
        entityType: "agent",
        agent: {
          id: "12345678-1234-7123-8123-123456789012",
          agentName: "test-service-agent",
          publicKey: "test-public-key",
          createdAt: new Date(),
          roles: []
        }
      }

      const result = await authService.initiatePrivilegeTokenGenerationForWeb(agentEntity)()
      expect(result).toBeLeftOf("auth_invalid_entity")
    })
  })
})
