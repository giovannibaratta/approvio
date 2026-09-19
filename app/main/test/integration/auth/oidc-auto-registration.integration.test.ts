import {Test, TestingModule} from "@nestjs/testing"
import {INestApplication} from "@nestjs/common"
import request from "supertest"
import {AppModule} from "@app/app.module"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider, createMockUserInDb} from "@test/mock-data"
import {PrismaClient} from "@prisma/client"
import "@utils/matchers"
import {simulateOidcAuthorization, OidcMockUser} from "@test/oidc-test-helpers"
import "expect-more-jest"
import {v7 as uuidv7} from "uuid"

/**
 * ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 * │                          OIDC Auto-Registration Integration Tests                       │
 * │                        (Tests Bootstrap and Auto-Registration)                          │
 * ├─────────────────────────────────────────────────────────────────────────────────────────┤
 * │                                                                                         │
 * │ Test Scenarios:                                                                         │
 * │ 1. First User Bootstrap: User who successfully authenticates with OIDC becomes          │
 * │    organization admin when no other org admins exist in the system                      │
 * │                                                                                         │
 * │ 2. Subsequent User Auto-Registration: Additional users who authenticate with OIDC       │
 * │    are auto-registered as regular members                                               │
 * │                                                                                         │
 * │ 3. Existing User Flow: Users already in the system continue to work normally            │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 */
describe("OIDC Auto-Registration Integration", () => {
  let app: INestApplication
  let prisma: PrismaClient
  let configProvider: ConfigProvider

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromOriginalProvider({tenantConnectionUrl: isolatedDb}))
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(isolatedDb)
    configProvider = module.get(ConfigProvider)

    await app.init()
  }, 20000)

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  beforeEach(async () => {})

  describe("First User Bootstrap Scenario", () => {
    it("should auto-register first OIDC user without organization membership", async () => {
      // Given: No users exist in the system (bootstrap scenario)
      const userCount = await prisma.user.count()
      const orgAdminCount = await prisma.user.count({where: {orgRole: "admin"}})
      expect(userCount).toBe(0)
      expect(orgAdminCount).toBe(0)

      // Given: OIDC mock user that doesn't exist in local database
      const uniqueId = Date.now().toString()
      const uuid = uuidv7()
      const userEmail = `first-user-${uniqueId}@example.com`
      const displayName = "First Bootstrap User"

      const testUser: OidcMockUser = {
        SubjectId: uuid,
        Username: `firstuser-${uniqueId}`,
        Password: "testpassword123",
        Claims: [
          {Type: "name", Value: displayName},
          {Type: "email", Value: userEmail},
          {Type: "email_verified", Value: "true"}
        ]
      }

      // When: User completes OIDC authentication flow
      const loginResponse = await request(app.getHttpServer()).get("/auth/web/login").expect(302)
      const redirectLocation = loginResponse.headers.location ?? ""
      const urlParams = new URLSearchParams(redirectLocation.split("?")[1] ?? "")
      const state = urlParams.get("state") ?? ""

      const authCode = await simulateOidcAuthorization(redirectLocation, testUser, configProvider)

      const tokenResponse = await request(app.getHttpServer()).post("/auth/cli/token").send({
        code: authCode,
        state: state
      })

      // Expect: JWT token is successfully generated
      expect(tokenResponse).toHaveStatusCode(201)
      expect(tokenResponse.body).toMatchObject({
        accessToken: expect.toBeVisibleString(),
        refreshToken: expect.toBeVisibleString()
      })

      // Expect: User was auto-registered as a platform account
      const createdAccounts = await prisma.platformAccount.findMany()
      expect(createdAccounts).toHaveLength(1)
      expect(createdAccounts[0]).toMatchObject({profileEmail: userEmail, displayName})
      // Expect: Registration did not create an organization membership
      expect(await prisma.user.count()).toBe(0)

      // Expect: User can access authenticated endpoints and has no organizations
      const organizationsResponse = await request(app.getHttpServer())
        .get("/organizations")
        .set("Authorization", `Bearer ${tokenResponse.body.accessToken}`)

      expect(organizationsResponse).toHaveStatusCode(200)
      expect(organizationsResponse.body).toMatchObject({items: [], total: 0})
    }, 20000)
  })

  describe("Subsequent User Auto-Registration", () => {
    it("should auto-register subsequent OIDC users without organization membership", async () => {
      // Given: First user already exists as organization admin
      await createMockUserInDb(prisma, {
        email: "existing-admin@example.com",
        displayName: "Existing Admin",
        orgRole: "admin"
      })

      // Given: Second OIDC user that doesn't exist in local database
      const uniqueId = Date.now().toString()
      const uuid = uuidv7()
      const userEmail = `second-user-${uniqueId}@example.com`
      const displayName = "Second Regular User"

      const testUser: OidcMockUser = {
        SubjectId: uuid,
        Username: `seconduser-${uniqueId}`,
        Password: "testpassword123",
        Claims: [
          {Type: "name", Value: displayName},
          {Type: "email", Value: userEmail},
          {Type: "email_verified", Value: "true"}
        ]
      }

      // When: Second user completes OIDC authentication flow
      const loginResponse = await request(app.getHttpServer()).get("/auth/web/login").expect(302)
      const redirectLocation = loginResponse.headers.location ?? ""
      const urlParams = new URLSearchParams(redirectLocation.split("?")[1] ?? "")
      const state = urlParams.get("state") ?? ""

      const authCode = await simulateOidcAuthorization(redirectLocation, testUser, configProvider)

      const tokenResponse = await request(app.getHttpServer()).post("/auth/cli/token").send({
        code: authCode,
        state: state
      })

      // Expect: JWT token is successfully generated
      expect(tokenResponse).toHaveStatusCode(201)
      expect(tokenResponse.body).toMatchObject({
        accessToken: expect.toBeVisibleString(),
        refreshToken: expect.toBeVisibleString()
      })

      // Expect: Second user was auto-registered as a platform account
      const secondAccount = await prisma.platformAccount.findFirst({where: {profileEmail: userEmail}})
      expect(secondAccount).toMatchObject({displayName})
      // Expect: Registration did not create an additional organization membership
      expect(await prisma.user.count()).toBe(1)

      // Expect: Second user can access authenticated endpoints and has no organizations
      const organizationsResponse = await request(app.getHttpServer())
        .get("/organizations")
        .set("Authorization", `Bearer ${tokenResponse.body.accessToken}`)

      expect(organizationsResponse).toHaveStatusCode(200)
      expect(organizationsResponse.body).toMatchObject({items: [], total: 0})
    }, 20000)
  })

  describe("Existing User Flow", () => {
    it("should reuse the existing account when provider and subject match", async () => {
      // Given: User already exists in the database
      const userEmail = "existing-user@example.com"
      const displayName = "Existing User"
      const uuid = uuidv7()

      const existingUser = await createMockUserInDb(prisma, {
        email: userEmail,
        displayName,
        identity: {providerId: "custom", subjectId: uuid}
      })

      // Given: OIDC mock user with same email as existing user
      const uniqueId = Date.now().toString()

      const testUser: OidcMockUser = {
        SubjectId: uuid,
        Username: `existinguser-${uniqueId}`,
        Password: "testpassword123",
        Claims: [
          {Type: "name", Value: displayName},
          {Type: "email", Value: userEmail},
          {Type: "email_verified", Value: "true"}
        ]
      }

      // When: Existing user completes OIDC authentication flow
      const loginResponse = await request(app.getHttpServer()).get("/auth/web/login").expect(302)
      const redirectLocation = loginResponse.headers.location ?? ""
      const urlParams = new URLSearchParams(redirectLocation.split("?")[1] ?? "")
      const state = urlParams.get("state") ?? ""

      const authCode = await simulateOidcAuthorization(redirectLocation, testUser, configProvider)

      const tokenResponse = await request(app.getHttpServer()).post("/auth/cli/token").send({
        code: authCode,
        state: state
      })

      // Expect: JWT token is successfully generated
      expect(tokenResponse).toHaveStatusCode(201)
      expect(tokenResponse.body).toMatchObject({
        accessToken: expect.toBeVisibleString(),
        refreshToken: expect.toBeVisibleString()
      })

      // Expect: No new users were created (existing user was used)
      const allUsers = await prisma.user.findMany()
      expect(allUsers).toHaveLength(1)
      expect(allUsers[0]?.id).toBe(existingUser.id)
      const existingAccount = await prisma.platformAccount.findUnique({where: {id: allUsers[0]?.platformAccountId}})
      expect(existingAccount?.profileEmail).toBe(userEmail)

      // Expect: Login reused the existing account and identity
      expect(await prisma.platformAccount.count()).toBe(1)
      expect(await prisma.platformAccountIdentity.count()).toBe(1)
      const organizationsResponse = await request(app.getHttpServer())
        .get("/organizations")
        .set("Authorization", `Bearer ${tokenResponse.body.accessToken}`)

      expect(organizationsResponse).toHaveStatusCode(200)
      expect(organizationsResponse.body).toMatchObject({
        items: [expect.objectContaining({id: existingUser.organizationId})],
        total: 1
      })
    }, 20000)

    it("should create a separate account when another provider asserts the same email", async () => {
      // Given: User already has an account and membership linked to another provider
      const userEmail = "conflict-user@example.com"
      const displayName = "Conflict User"

      const existingUser = await createMockUserInDb(prisma, {
        email: userEmail,
        displayName,
        identity: {providerId: "other-provider", issuer: "https://other-provider.example.com", subjectId: uuidv7()}
      })

      // Given: The configured custom provider asserts the same verified email for its own identity
      const uniqueId = Date.now().toString()
      const uuid = uuidv7()

      const testUser: OidcMockUser = {
        SubjectId: uuid,
        Username: `conflictuser-${uniqueId}`,
        Password: "testpassword123",
        Claims: [
          {Type: "name", Value: displayName},
          {Type: "email", Value: userEmail},
          {Type: "email_verified", Value: "true"}
        ]
      }

      // When: User attempts OIDC login
      const loginResponse = await request(app.getHttpServer()).get("/auth/web/login").expect(302)
      const redirectLocation = loginResponse.headers.location ?? ""
      const urlParams = new URLSearchParams(redirectLocation.split("?")[1] ?? "")
      const state = urlParams.get("state") ?? ""

      const authCode = await simulateOidcAuthorization(redirectLocation, testUser, configProvider)

      const tokenResponse = await request(app.getHttpServer()).post("/auth/cli/token").send({
        code: authCode,
        state: state
      })

      // Expect: Login succeeds with a separate platform account
      expect(tokenResponse).toHaveStatusCode(201)
      expect(await prisma.platformAccount.count()).toBe(2)

      const newIdentity = await prisma.platformAccountIdentity.findFirst({
        where: {providerId: "custom", subject: uuid}
      })
      expect(newIdentity).toMatchObject({accountId: expect.toBeVisibleString()})
      expect(newIdentity?.accountId).not.toBe(existingUser.platformAccountId)

      // Expect: The original identity and membership remain attached to the original account
      expect(await prisma.platformAccountIdentity.findFirst({where: {providerId: "other-provider"}})).toMatchObject({
        accountId: existingUser.platformAccountId
      })
      expect(await prisma.user.findMany()).toMatchObject([
        {id: existingUser.id, platformAccountId: existingUser.platformAccountId}
      ])

      // Expect: The new account does not inherit the original account's organization membership
      const organizationsResponse = await request(app.getHttpServer())
        .get("/organizations")
        .set("Authorization", `Bearer ${tokenResponse.body.accessToken}`)

      expect(organizationsResponse).toHaveStatusCode(200)
      expect(organizationsResponse.body).toMatchObject({items: [], total: 0})
    }, 20000)

    it("should reject login when OIDC provider returns email_verified as false", async () => {
      // Given: OIDC user with unverified email
      const uniqueId = Date.now().toString()
      const uuid = uuidv7()
      const userEmail = `unverified-${uniqueId}@example.com`
      const displayName = "Unverified User"

      const testUser: OidcMockUser = {
        SubjectId: uuid,
        Username: `unverified-${uniqueId}`,
        Password: "testpassword123",
        Claims: [
          {Type: "name", Value: displayName},
          {Type: "email", Value: userEmail},
          {Type: "email_verified", Value: "false"}
        ]
      }

      // When: User attempts OIDC login
      const loginResponse = await request(app.getHttpServer()).get("/auth/web/login").expect(302)
      const redirectLocation = loginResponse.headers.location ?? ""
      const urlParams = new URLSearchParams(redirectLocation.split("?")[1] ?? "")
      const state = urlParams.get("state") ?? ""

      const authCode = await simulateOidcAuthorization(redirectLocation, testUser, configProvider)

      const tokenResponse = await request(app.getHttpServer()).post("/auth/cli/token").send({
        code: authCode,
        state: state
      })

      // Expect: Login is rejected because email is unverified
      expect(tokenResponse).toHaveStatusCode(400)
      expect(tokenResponse.body).toMatchObject({
        code: "AUTH_MISSING_EMAIL_FROM_OIDC_PROVIDER"
      })
    }, 20000)
  })
})
