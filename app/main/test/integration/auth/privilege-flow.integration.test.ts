import {Test, TestingModule} from "@nestjs/testing"
import {INestApplication} from "@nestjs/common"
import * as request from "supertest"
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
import {AuthenticatedUser, OrgRole} from "@domain"
import "@utils/matchers"

describe("Privilege Flow Integration", () => {
  let app: INestApplication
  let prisma: PrismaClient
  let testUser: OidcMockUser
  let configProvider: ConfigProvider
  let authService: AuthService
  let jwtService: JwtService

  beforeEach(async () => {
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
    mockConfigProvider.oidcConfig.provider = "auth0" // Must be supported provider for step-up auth

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(mockConfigProvider)
      .compile()

    app = module.createNestApplication()
    prisma = module.get(DatabaseClient)
    configProvider = module.get(ConfigProvider)
    authService = module.get(AuthService)
    jwtService = module.get(JwtService)

    // Create database user with email that matches OIDC user claims
    await createMockUserInDb(prisma, {
      displayName,
      email: userEmail
    })

    await app.init()
  }, 20000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  describe("Complete Privilege Token Flow", () => {
    it("should successfully complete step-up auth and enforce single-use", async () => {
      // 1. Initial Login to get a standard access token
      const loginResponse = await request(app.getHttpServer()).get("/auth/login").expect(302)
      const loginLocation = loginResponse.headers.location
      const loginStateMatch = loginLocation?.match(/state=([^&]+)/)
      const loginState = loginStateMatch ? loginStateMatch[1] : null
      expect(loginState).toBeTruthy()

      if (!loginLocation) throw new Error("Login location not found")

      const loginCode = await simulateOidcAuthorization(loginLocation, testUser, configProvider)

      await request(app.getHttpServer()).get(`/auth/callback?code=${loginCode}&state=${loginState}`).expect(302)

      const tokenResponse = await request(app.getHttpServer())
        .post("/auth/token")
        .send({code: loginCode, state: loginState})
        .expect(201)

      const standardAccessToken = tokenResponse.body.accessToken
      expect(standardAccessToken).toBeTruthy()

      // 2. Initiate Privilege Token Exchange
      const initiateResponse = await request(app.getHttpServer())
        .get("/auth/initiatePrivilegedTokenExchange")
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
        .post("/auth/exchangePrivilegedToken")
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
  })
})
