import {Test, TestingModule} from "@nestjs/testing"
import {INestApplication} from "@nestjs/common"
import * as request from "supertest"
import {AppModule} from "@app/app.module"
import * as crypto from "crypto"
import {DatabaseClient} from "@external/database"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider} from "@test/mock-data"
import {PrismaClient} from "@prisma/client"
import "@utils/matchers"
import {simulateOidcAuthorization, OidcMockUser} from "@test/oidc-test-helpers"

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

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromOriginalProvider({dbConnectionUrl: isolatedDb}))
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication()
    prisma = module.get(DatabaseClient)
    configProvider = module.get(ConfigProvider)

    await app.init()
  }, 20000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  describe("First User Bootstrap Scenario", () => {
    it("should auto-register first OIDC user as organization admin", async () => {
      // Given: No users exist in the system (bootstrap scenario)
      const userCount = await prisma.user.count()
      const orgAdminCount = await prisma.organizationAdmin.count()
      expect(userCount).toBe(0)
      expect(orgAdminCount).toBe(0)

      // Given: OIDC mock user that doesn't exist in local database
      const uniqueId = Date.now().toString()
      const uuid = crypto.randomUUID()
      const userEmail = `first-user-${uniqueId}@example.com`
      const displayName = "First Bootstrap User"

      const testUser: OidcMockUser = {
        SubjectId: uuid,
        Username: `firstuser-${uniqueId}`,
        Password: "testpassword123",
        Claims: [
          {Type: "name", Value: displayName},
          {Type: "email", Value: userEmail}
        ]
      }

      // When: User completes OIDC authentication flow
      const loginResponse = await request(app.getHttpServer()).get("/auth/login").expect(302)
      const redirectLocation = loginResponse.headers.location
      const urlParams = new URLSearchParams(redirectLocation!.split("?")[1])
      const state = urlParams.get("state") ?? ""

      const authCode = await simulateOidcAuthorization(redirectLocation!, testUser, configProvider)
      await request(app.getHttpServer()).get("/auth/callback").query({code: authCode, state: state}).expect(302)

      const tokenResponse = await request(app.getHttpServer()).post("/auth/token").send({
        code: authCode,
        state: state
      })

      // Expect: JWT token is successfully generated
      expect(tokenResponse).toHaveStatusCode(201)
      expect(tokenResponse.body).toHaveProperty("token")
      expect(typeof tokenResponse.body.token).toBe("string")

      // Expect: User was auto-registered in the database
      const createdUsers = await prisma.user.findMany()
      expect(createdUsers).toHaveLength(1)
      expect(createdUsers[0]?.email).toBe(userEmail)
      expect(createdUsers[0]?.displayName).toBe(displayName)

      // Expect: User was granted organization admin privileges (first user bootstrap)
      const orgAdmins = await prisma.organizationAdmin.findMany()
      expect(orgAdmins).toHaveLength(1)
      expect(orgAdmins[0]?.email).toBe(userEmail)

      // Expect: User can access authenticated endpoints with admin role
      const infoResponse = await request(app.getHttpServer())
        .get("/auth/info")
        .set("Authorization", `Bearer ${tokenResponse.body.token}`)

      expect(infoResponse).toHaveStatusCode(200)
      expect(infoResponse.body).toEqual({entityType: "user"})
    }, 20000)
  })

  describe("Subsequent User Auto-Registration", () => {
    it("should auto-register subsequent OIDC users as regular members", async () => {
      // Given: First user already exists as organization admin
      const firstUser = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: "existing-admin@example.com",
          displayName: "Existing Admin",
          createdAt: new Date(),
          occ: 0
        }
      })
      await prisma.organizationAdmin.create({
        data: {
          id: crypto.randomUUID(),
          email: firstUser.email,
          createdAt: new Date()
        }
      })

      // Given: Second OIDC user that doesn't exist in local database
      const uniqueId = Date.now().toString()
      const uuid = crypto.randomUUID()
      const userEmail = `second-user-${uniqueId}@example.com`
      const displayName = "Second Regular User"

      const testUser: OidcMockUser = {
        SubjectId: uuid,
        Username: `seconduser-${uniqueId}`,
        Password: "testpassword123",
        Claims: [
          {Type: "name", Value: displayName},
          {Type: "email", Value: userEmail}
        ]
      }

      // When: Second user completes OIDC authentication flow
      const loginResponse = await request(app.getHttpServer()).get("/auth/login").expect(302)
      const redirectLocation = loginResponse.headers.location
      const urlParams = new URLSearchParams(redirectLocation!.split("?")[1])
      const state = urlParams.get("state") ?? ""

      const authCode = await simulateOidcAuthorization(redirectLocation!, testUser, configProvider)
      await request(app.getHttpServer()).get("/auth/callback").query({code: authCode, state: state}).expect(302)

      const tokenResponse = await request(app.getHttpServer()).post("/auth/token").send({
        code: authCode,
        state: state
      })

      // Expect: JWT token is successfully generated
      expect(tokenResponse).toHaveStatusCode(201)
      expect(tokenResponse.body).toHaveProperty("token")

      // Expect: Second user was auto-registered in the database
      const allUsers = await prisma.user.findMany()
      expect(allUsers).toHaveLength(2)
      const secondUser = allUsers.find(u => u.email === userEmail)
      expect(secondUser).toBeDefined()
      expect(secondUser?.displayName).toBe(displayName)

      // Expect: Second user was NOT granted organization admin privileges
      const orgAdmins = await prisma.organizationAdmin.findMany()
      expect(orgAdmins).toHaveLength(1) // Still only the first user
      expect(orgAdmins[0]?.email).toBe("existing-admin@example.com")

      // Expect: Second user can access authenticated endpoints as regular member
      const infoResponse = await request(app.getHttpServer())
        .get("/auth/info")
        .set("Authorization", `Bearer ${tokenResponse.body.token}`)

      expect(infoResponse).toHaveStatusCode(200)
      expect(infoResponse.body).toEqual({entityType: "user"})
    }, 20000)
  })

  describe("Existing User Flow", () => {
    it("should continue to work normally for users that already exist", async () => {
      // Given: User already exists in the database
      const userEmail = "existing-user@example.com"
      const displayName = "Existing User"

      const existingUser = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: userEmail,
          displayName: displayName,
          createdAt: new Date(),
          occ: 0
        }
      })

      // Given: OIDC mock user with same email as existing user
      const uniqueId = Date.now().toString()
      const uuid = crypto.randomUUID()

      const testUser: OidcMockUser = {
        SubjectId: uuid,
        Username: `existinguser-${uniqueId}`,
        Password: "testpassword123",
        Claims: [
          {Type: "name", Value: displayName},
          {Type: "email", Value: userEmail}
        ]
      }

      // When: Existing user completes OIDC authentication flow
      const loginResponse = await request(app.getHttpServer()).get("/auth/login").expect(302)
      const redirectLocation = loginResponse.headers.location
      const urlParams = new URLSearchParams(redirectLocation!.split("?")[1])
      const state = urlParams.get("state") ?? ""

      const authCode = await simulateOidcAuthorization(redirectLocation!, testUser, configProvider)
      await request(app.getHttpServer()).get("/auth/callback").query({code: authCode, state: state}).expect(302)

      const tokenResponse = await request(app.getHttpServer()).post("/auth/token").send({
        code: authCode,
        state: state
      })

      // Expect: JWT token is successfully generated
      expect(tokenResponse).toHaveStatusCode(201)
      expect(tokenResponse.body).toHaveProperty("token")

      // Expect: No new users were created (existing user was used)
      const allUsers = await prisma.user.findMany()
      expect(allUsers).toHaveLength(1)
      expect(allUsers[0]?.id).toBe(existingUser.id)
      expect(allUsers[0]?.email).toBe(userEmail)

      // Expect: User can access authenticated endpoints
      const infoResponse = await request(app.getHttpServer())
        .get("/auth/info")
        .set("Authorization", `Bearer ${tokenResponse.body.token}`)

      expect(infoResponse).toHaveStatusCode(200)
      expect(infoResponse.body).toEqual({entityType: "user"})
    }, 20000)
  })
})
