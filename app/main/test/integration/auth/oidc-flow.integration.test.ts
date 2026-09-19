import {Test, TestingModule} from "@nestjs/testing"
import {INestApplication} from "@nestjs/common"
import request from "supertest"
import {AppModule} from "@app/app.module"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider} from "@test/mock-data"
import {PrismaClient} from "@prisma/client"
import "@utils/matchers"
import {simulateOidcAuthorization, OidcMockUser} from "@test/oidc-test-helpers"
import "expect-more-jest"
import {v7 as uuidv7} from "uuid"

/**
 * ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 * │                          Mock OIDC Server Integration Test Flow                         │
 * │                       (Simulates Real OIDC Provider Behavior)                          │
 * ├─────────────────────────────────────────────────────────────────────────────────────────┤
 * │                                                                                         │
 * │ Test Code         Mock OIDC Server             Approvio Backend      Database          │
 * │    │              (localhost:4011)                    │                 │              │
 * │ 1. Setup Phase                                                                          │
 * │    │ Create user ────────────────►│ POST /api/v1/user  │                 │              │
 * │    │ via API                      │ {SubjectId,        │                 │              │
 * │    │                              │  Username,         │                 │              │
 * │    │                              │  Password,         │                 │              │
 * │    │                              │  Claims: [         │                 │              │
 * │    │                              │    {Type: "name",  │                 │              │
 * │    │                              │     Value: "..."}  │                 │              │
 * │    │                              │  ]}                │                 │              │
 * │    │                              │                    │                 │              │
 * │    │ Create DB user ─────────────────────────────────►│ Match SubjectId │              │
 * │    │ matching OIDC                                     │ with OIDC user  │              │
 * │    │                                                   │                 │              │
 * │ 2. Authentication Flow Simulation                                                       │
 * │    │ GET /auth/web/login ─────────────────────────────►│ Generate PKCE   │              │
 * │    │                                                   │ & auth URL      │              │
 * │    │                              │                    │                 │              │
 * │    │ Extract auth URL ◄───────────────────────────────│ 302 Redirect    │              │
 * │    │ with PKCE params                                  │ to OIDC         │              │
 * │    │                              │                    │                 │              │
 * │ 3. Mock OIDC Login Simulation                                                           │
 * │    │ GET auth URL ───────────────►│ Return HTML login  │                 │              │
 * │    │                              │ form with tokens   │                 │              │
 * │    │                              │                    │                 │              │
 * │    │ Extract cookies &            │ Form contains:     │                 │              │
 * │    │ verification tokens          │ • __RequestVerif.  │                 │              │
 * │    │                              │ • Input.ReturnUrl  │                 │              │
 * │    │                              │   (HTML encoded!)  │                 │              │
 * │    │                              │                    │                 │              │
 * │    │ HTML decode ReturnUrl        │ Fix: &amp; → &      │                 │              │
 * │    │ (Critical fix!)              │ &lt; → <, etc.     │                 │              │
 * │    │                              │                    │                 │              │
 * │    │ POST /Account/Login ────────►│ Validate creds &   │                 │              │
 * │    │ with decoded ReturnUrl       │ redirect to        │                 │              │
 * │    │                              │ /connect/authorize │                 │              │
 * │    │                              │                    │                 │              │
 * │    │ Follow redirects ───────────►│ Generate auth code │                 │              │
 * │    │ to get auth code             │ & redirect to      │                 │              │
 * │    │                              │ callback URL       │                 │              │
 * │    │                              │                    │                 │              │
 * │    │ Extract auth code            │ Final redirect:    │                 │              │
 * │    │ from final redirect          │ /auth/web/callback │                 │              │
 * │    │                              │ code=abc&state=xyz │                 │              │
 * │    │                              │                    │                 │              │
 * │ 4. Backend Integration Test                                                             │
 * │    │                              │                    │                 │              │
 * │    │ POST /auth/cli/token ───────────────────────────►│ Retrieve PKCE ◄────────────────│
 * │    │ {code, state}                                     │ by state        │              │
 * │    │                              │                    │                 │              │
 * │    │                              │ Exchange tokens ◄─│ Use retrieved   │              │
 * │    │                              │ with OIDC server   │ codeVerifier    │              │
 * │    │                              │                    │                 │              │
 * │    │                              │ Return user info ─►│ Get enhanced    │              │
 * │    │                              │ (basic claims)     │ user data       │              │
 * │    │                              │                    │                 │              │
 * │    │ Enhanced JWT ◄──────────────────────────────────│ Generate JWT    │              │
 * │    │ w/ orgRole &                                      │ with orgRole    │              │
 * │    │ permissions                                       │ + permissions   │              │
 * │                                                                                         │
 * │ Key Test Challenges Solved:                                                             │
 * │ • HTML Entity Decoding: ReturnUrl contains &amp; instead of & in HTML form             │
 * │ • Cookie Management: Preserve session cookies across redirects                        │
 * │ • Form Token Extraction: Parse __RequestVerificationToken from HTML                   │
 * │ • Mock User Creation: Create users dynamically via OIDC server API                    │
 * │ • Real OIDC Flow: Uses actual OIDC server instead of mocking library calls            │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 */
describe("OIDC Flow Integration", () => {
  let app: INestApplication
  let prisma: PrismaClient
  let testUser: OidcMockUser
  let configProvider: ConfigProvider
  let accountId: string
  let providerId: string

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    // Create test user data for real OIDC server creation
    const uniqueId = Date.now().toString()
    // Generate a proper UUID v4 format
    const uuid = uuidv7()
    const userEmail = `test-${uniqueId}@localhost.com`
    const displayName = "Test User"

    testUser = {
      SubjectId: uuid,
      Username: `testuser-${uniqueId}`,
      Password: "testpassword123",
      Claims: [
        {
          Type: "name",
          Value: displayName
        },
        {
          Type: "email",
          Value: userEmail
        },
        {
          Type: "email_verified",
          Value: "true"
        }
      ]
    }

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

    providerId = "custom"
    accountId = uuidv7()
    const now = new Date()
    await prisma.platformAccount.create({
      data: {
        id: accountId,
        displayName,
        profileEmail: "user@example.com",
        status: "active",
        createdAt: now,
        updatedAt: now,
        occ: 0n
      }
    })
    await prisma.platformAccountIdentity.create({
      data: {
        id: uuidv7(),
        accountId,
        providerId,
        issuer: "http://localhost:4011",
        subject: uuid,
        createdAt: now,
        occ: 0n
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

  describe("Complete OIDC Authentication Flow", () => {
    it("should complete full login -> callback -> token flow", async () => {
      // Given: OIDC mock server is running and configured

      // When: User initiates login
      const loginResponse = await request(app.getHttpServer()).get("/auth/web/login").expect(302)

      // Expect: Login redirects to OIDC provider with proper parameters
      const redirectLocation = loginResponse.headers.location
      expect(redirectLocation).toBeTruthy()
      expect(redirectLocation).toContain("response_type=code")
      expect(redirectLocation).toContain("client_id=integration-test-client-id")
      expect(redirectLocation).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fweb%2Fcallback")
      expect(redirectLocation).toContain("scope=openid+profile+email")
      expect(redirectLocation).toContain("code_challenge=")
      expect(redirectLocation).toContain("code_challenge_method=S256")
      expect(redirectLocation).toContain("state=")

      // Extract state and code_challenge for later use
      const urlParams = new URLSearchParams(redirectLocation?.split("?")[1] ?? "")
      const state = urlParams.get("state") ?? ""
      const codeChallenge = urlParams.get("code_challenge") ?? ""

      expect(state).toBeTruthy()
      expect(codeChallenge).toBeTruthy()

      // The backend should have store a session to be user in subsequent calls
      const session = await prisma.pkceSession.findUnique({
        where: {state}
      })

      expect(session).toBeTruthy()

      // When: Simulate OIDC provider authorization (get authorization code)
      const authCode = await simulateOidcAuthorization(redirectLocation ?? "", testUser, configProvider)
      expect(authCode).toBeTruthy()

      // When: Frontend exchanges authorization code for JWT token
      const tokenResponse = await request(app.getHttpServer()).post("/auth/cli/token").send({
        code: authCode,
        state: state
      })

      // Expect: Valid JWT token is returned
      expect(tokenResponse).toHaveStatusCode(201)
      expect(tokenResponse.body).toMatchObject({
        accessToken: expect.toBeVisibleString(),
        refreshToken: expect.toBeVisibleString()
      })

      // When: Use the issued access token to access an authenticated endpoint
      const organizationsResponse = await request(app.getHttpServer())
        .get("/organizations")
        .set("Authorization", `Bearer ${tokenResponse.body.accessToken}`)

      // Expect: The token authenticates the account, which has no organization memberships
      expect(organizationsResponse).toHaveStatusCode(200)
      expect(organizationsResponse.body).toMatchObject({items: [], total: 0})

      // Expect: An active browser session exists without a selected organization
      const browserSession = await prisma.browserSession.findFirst({
        where: {accountId, providerId, transport: "browser", status: "active"}
      })
      expect(browserSession).toMatchObject({selectedOrganizationId: null, contextVersion: 0n})

      // Expect: The refresh token is bound to the browser session
      const refreshTokens = await prisma.refreshToken.findMany({where: {accountId, providerId}})
      expect(refreshTokens).toHaveLength(1)
      expect(refreshTokens[0]).toMatchObject({sessionId: browserSession?.id})
    }, 20000)
  })
})
