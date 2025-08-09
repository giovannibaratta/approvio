import {Test, TestingModule} from "@nestjs/testing"
import {INestApplication} from "@nestjs/common"
import * as request from "supertest"
import {AppModule} from "@app/app.module"
import * as crypto from "crypto"
import {DatabaseClient} from "@external/database"
import {cleanDatabase, prepareDatabase} from "../database"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider, createMockUserInDb} from "../shared/mock-data"
import {PrismaClient} from "@prisma/client"
import axios from "axios"

interface OidcMockUser {
  SubjectId: string
  Username: string
  Password: string
  Claims: Array<{
    Type: string
    Value: string
  }>
}

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
 * │    │ GET /auth/login ─────────────────────────────────►│ Generate PKCE   │              │
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
 * │    │ from final redirect          │ /auth/callback?    │                 │              │
 * │    │                              │ code=abc&state=xyz │                 │              │
 * │    │                              │                    │                 │              │
 * │ 4. Backend Integration Test                                                             │
 * │    │ GET /auth/callback ─────────────────────────────►│ Validate &      │              │
 * │    │ ?code=abc&state=xyz                               │ redirect to     │              │
 * │    │                              │                    │ /success        │              │
 * │    │                              │                    │                 │              │
 * │    │ POST /auth/token ───────────────────────────────►│ Retrieve PKCE ◄────────────────│
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

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    // Create test user data for real OIDC server creation
    const uniqueId = Date.now().toString()
    // Generate a proper UUID v4 format
    const uuid = crypto.randomUUID()
    testUser = {
      SubjectId: uuid,
      Username: `testuser-${uniqueId}`,
      Password: "testpassword123",
      Claims: [
        {
          Type: "name",
          Value: "Test User"
        },
        {
          Type: "email",
          Value: `test-${uniqueId}@localhost.com`
        }
      ]
    }

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

    // Create database user that matches OIDC user SubjectId
    await createMockUserInDb(prisma, {
      id: testUser.SubjectId,
      displayName: testUser.Claims.find(c => c.Type === "name")?.Value || "Test User",
      email: testUser.Claims.find(c => c.Type === "email")?.Value || "test@localhost.com"
    })

    await app.init()
  }, 20000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  describe("Complete OIDC Authentication Flow", () => {
    it("should complete full login -> callback -> token flow", async () => {
      // Given: OIDC mock server is running and configured

      // When: User initiates login
      const loginResponse = await request(app.getHttpServer()).get("/auth/login").expect(302)

      // Expect: Login redirects to OIDC provider with proper parameters
      const redirectLocation = loginResponse.headers.location
      expect(redirectLocation).toBeTruthy()
      expect(redirectLocation).toContain("response_type=code")
      expect(redirectLocation).toContain("client_id=integration-test-client-id")
      expect(redirectLocation).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback")
      expect(redirectLocation).toContain("scope=openid+profile+email")
      expect(redirectLocation).toContain("code_challenge=")
      expect(redirectLocation).toContain("code_challenge_method=S256")
      expect(redirectLocation).toContain("state=")

      // Extract state and code_challenge for later use
      const urlParams = new URLSearchParams(redirectLocation!.split("?")[1])
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
      const authCode = await simulateOidcAuthorization(redirectLocation!, testUser, configProvider)
      expect(authCode).toBeTruthy()

      // When: OIDC provider redirects back to callback
      const callbackResponse = await request(app.getHttpServer())
        .get("/auth/callback")
        .query({code: authCode, state: state})
        .expect(302)

      // Expect: Callback redirects to success with code and state
      expect(callbackResponse.headers.location).toBe(`/auth/success?code=${authCode}&state=${state}`)

      // When: Frontend exchanges authorization code for JWT token
      const tokenResponse = await request(app.getHttpServer()).post("/auth/token").send({
        code: authCode,
        state: state
      })

      // Expect: Valid JWT token is returned
      expect(tokenResponse.status).toBe(201)
      expect(tokenResponse.body).toHaveProperty("token")
      expect(typeof tokenResponse.body.token).toBe("string")
      expect(tokenResponse.body.token.length).toBeGreaterThan(0)

      // When: Use JWT token to access /auth/info endpoint
      const infoResponse = await request(app.getHttpServer())
        .get("/auth/info")
        .set("Authorization", `Bearer ${tokenResponse.body.token}`)

      // Expect: User info endpoint returns entity type
      expect(infoResponse.status).toBe(200)
      expect(infoResponse.body).toEqual({entityType: "user"})
    }, 20000)
  })
})

/**
 * Simulates the OIDC authorization flow by creating a user and performing real login
 */
async function simulateOidcAuthorization(
  redirectLocation: string,
  testUser: OidcMockUser,
  configProvider: ConfigProvider
): Promise<string> {
  // Step 1: Create user on OIDC server via API
  const oidcApiUrl = `${configProvider.oidcConfig.issuerUrl}/api/v1/user`
  const createUserResponse = await axios.post(oidcApiUrl, testUser, {
    headers: {"Content-Type": "application/json"}
  })

  if (createUserResponse.status !== 200) {
    throw new Error(`Failed to create OIDC user: ${createUserResponse.status}`)
  }

  // Step 2: Get the login form HTML to extract verification tokens
  const loginFormResponse = await axios.get(redirectLocation)
  const loginFormHtml = loginFormResponse.data

  // Extract cookies from login form response
  const cookies = loginFormResponse.headers["set-cookie"] || []
  const cookieHeader = cookies.map(cookie => cookie.split(";")[0]).join("; ")

  // Step 3: Extract verification token and ReturnUrl from the HTML form
  const verificationTokenMatch = loginFormHtml.match(
    /name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]*)"/
  )
  const returnUrlMatch = loginFormHtml.match(/name="Input.ReturnUrl"\s+value="([^"]*)"/)

  const verificationToken = verificationTokenMatch?.[1]
  const returnUrl = returnUrlMatch?.[1]

  // HTML decode the ReturnUrl since it was extracted from HTML content
  const decodedReturnUrl = returnUrl
    ?.replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')

  if (!verificationToken || !decodedReturnUrl) {
    throw new Error("Could not extract __RequestVerificationToken or Input.ReturnUrl from login form")
  }

  // Step 4: Submit login form with real credentials
  const loginFormData = new URLSearchParams({
    "Input.Username": testUser.Username,
    "Input.Password": testUser.Password,
    "Input.ReturnUrl": decodedReturnUrl,
    "Input.RememberLogin": "false",
    "Input.Button": "login",
    __RequestVerificationToken: verificationToken
  })

  const loginResponse = await axios.post("http://localhost:4011/Account/Login", loginFormData.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader,
      Referer: redirectLocation
    },
    // We don't want axios to follow redirects automatically,
    // as we need to capture the location header of the 302 response.
    maxRedirects: 0,
    validateStatus: status => status === 302
  })

  // Step 5: Handle the authorization redirect
  const location = loginResponse.headers.location
  if (!location) {
    throw new Error("No redirect location found after login")
  }

  if (!location.startsWith("/connect/authorize")) {
    throw new Error(`Unexpected redirect location: ${location}`)
  }

  // The login redirects to the authorization callback, we need to follow it
  // Update cookies from login response
  const loginCookies = loginResponse.headers["set-cookie"] || []
  const allCookies = [...cookies, ...loginCookies]
  const updatedCookieHeader = allCookies.map(cookie => cookie.split(";")[0]).join("; ")

  // Follow the authorization callback redirect to get the actual authorization code
  const callbackResponse = await axios.get(`http://localhost:4011${location}`, {
    maxRedirects: 0,
    validateStatus: status => status === 302,
    headers: {
      Cookie: updatedCookieHeader
    },
    withCredentials: true
  })

  const finalLocation = callbackResponse.headers.location
  if (!finalLocation) {
    throw new Error("No final redirect location found after authorization callback")
  }

  // Extract authorization code from the final redirect (which should go back to our app)
  const authCodeMatch = finalLocation.match(/code=([^&]+)/)
  const authCode = authCodeMatch ? authCodeMatch[1] : null

  if (!authCode) {
    throw new Error(`Could not extract authorization code from final redirect: ${finalLocation}`)
  }

  return authCode
}
