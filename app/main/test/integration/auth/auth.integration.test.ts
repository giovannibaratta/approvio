import {Test, TestingModule} from "@nestjs/testing"
import {HttpStatus, INestApplication} from "@nestjs/common"
import * as request from "supertest"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external/database"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider, createMockGroupInDb, createUserWithRefreshToken} from "@test/mock-data"
import {PrismaClient} from "@prisma/client"
import "expect-more-jest"
import {GRACE_PERIOD_SECONDS, RefreshTokenStatus} from "@domain"

describe("Auth Integration", () => {
  let app: INestApplication
  let prisma: PrismaClient

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

    app = module.createNestApplication({logger: ["error", "warn"]})
    prisma = module.get(DatabaseClient)

    await app.init()
  }, 20000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  // Helper to create a user and a refresh token
  const setupUserWithRefreshToken = async (
    expiresInSeconds = 3600,
    status: "active" | "used" | "revoked" = "active",
    createdAt = new Date()
  ) => {
    return await createUserWithRefreshToken(prisma, {
      tokenOverrides: {
        expiresInSeconds,
        status,
        createdAt
      },
      userOverrides: {
        displayName: "Test User",
        email: "test@example.com"
      }
    })
  }

  describe("GET /auth/web/login", () => {
    it("should redirect to OIDC provider with PKCE parameters", async () => {
      const response = await request(app.getHttpServer()).get("/auth/web/login")

      expect(response).toHaveStatusCode(302)
      const location = response.headers.location
      expect(location).toContain("response_type=code")
      expect(location).toContain("code_challenge=")
      expect(location).toContain("code_challenge_method=S256")
      expect(location).toContain("state=")
    })
  })

  describe("POST /auth/cli/token", () => {
    it("should return unauthorized without required parameters", async () => {
      // When: No required parameters
      const response = await request(app.getHttpServer()).post("/auth/cli/token")

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    })

    it("should return unauthorized with invalid PKCE verification", async () => {
      const response = await request(app.getHttpServer()).post("/auth/cli/token").send({
        code: "invalid-code",
        state: "invalid-state",
        codeVerifier: "invalid-verifier"
      })

      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    })
  })

  describe("GET /auth/info", () => {
    it("should return unauthorized without authentication token", async () => {
      const response = await request(app.getHttpServer()).get("/auth/info")

      expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
    })

    it("should return BAD REQUEST with invalid authentication token", async () => {
      // When: An invalid authentication token is used
      const response = await request(app.getHttpServer())
        .get("/auth/info")
        .set("Authorization", "Bearer invalid-jwt-token")

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    })

    it("should return groups for the authenticated user and respect isolation", async () => {
      // Given: A user with a valid access token
      const {user, token} = await setupUserWithRefreshToken()
      const refreshResponse = await request(app.getHttpServer())
        .post("/auth/cli/refresh")
        .send({refreshToken: token.plainToken})
      const validAccessToken = refreshResponse.body.accessToken

      // Given: Two groups, one with the user and one without
      const group1 = await createMockGroupInDb(prisma)
      await createMockGroupInDb(prisma)

      await prisma.groupMembership.create({
        data: {
          groupId: group1.id,
          userId: user.id,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      })

      // When: Requesting info
      const response = await request(app.getHttpServer())
        .get("/auth/info")
        .set("Authorization", `Bearer ${validAccessToken}`)

      // Expect
      expect(response).toHaveStatusCode(200)
      expect(response.body).toMatchObject({
        entityType: "user",
        groups: [
          {
            groupId: group1.id,
            groupName: group1.name
          }
        ]
      })
      expect(response.body.groups).toHaveLength(1)
    })

    it("should return empty groups when user has no memberships", async () => {
      // Given: A user with no memberships
      const {token} = await setupUserWithRefreshToken()
      const refreshResponse = await request(app.getHttpServer())
        .post("/auth/cli/refresh")
        .send({refreshToken: token.plainToken})
      const validAccessToken = refreshResponse.body.accessToken

      // When: Requesting info
      const response = await request(app.getHttpServer())
        .get("/auth/info")
        .set("Authorization", `Bearer ${validAccessToken}`)

      // Expect
      expect(response).toHaveStatusCode(200)
      expect(response.body).toMatchObject({
        entityType: "user",
        groups: []
      })
    })
  })

  describe("POST /auth/cli/refresh", () => {
    it("should return new tokens for valid refresh token", async () => {
      // Given: A user with a valid active refresh token
      const {token} = await setupUserWithRefreshToken()
      const {plainToken, tokenId} = token

      // When: Requesting refresh
      const response = await request(app.getHttpServer()).post("/auth/cli/refresh").send({refreshToken: plainToken})

      // Expect: the API call is successful
      expect(response).toHaveStatusCode(HttpStatus.OK)
      expect(response.body).toMatchObject({
        accessToken: expect.toBeString(),
        refreshToken: expect.toBeString()
      })
      expect(response.body.refreshToken).not.toBe(plainToken)

      // Expect: the refresh token is marked as used
      const usedToken = await prisma.refreshToken.findUnique({where: {id: tokenId}})
      expect(usedToken?.status).toBe(RefreshTokenStatus.USED)

      // Expect: the token can be used to query the endpoints
      // When: Use JWT token to access /auth/info endpoint
      const infoResponse = await request(app.getHttpServer())
        .get("/auth/info")
        .set("Authorization", `Bearer ${response.body.accessToken}`)

      // Expect: User info endpoint returns entity type
      expect(infoResponse).toHaveStatusCode(200)
    })

    it("should return 400 for expired refresh token", async () => {
      // Given: A user with an expired refresh token
      // Create at -2h, Expire at -1h (duration 1h). So it is valid at creation, but expired now.
      const createdAt = new Date(Date.now() - 7200 * 1000)
      const {token} = await setupUserWithRefreshToken(3600, "active", createdAt)
      const {plainToken} = token

      // When: Requesting refresh
      const response = await request(app.getHttpServer()).post("/auth/cli/refresh").send({refreshToken: plainToken})

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      expect(response.body).toHaveErrorCode("REFRESH_TOKEN_EXPIRED")
    })

    it("should return 400 and revoke family for used refresh token (Reuse Detection)", async () => {
      // Given: A user with a USED refresh token that was used outside the grace period
      const createdAt = new Date(Date.now() - (GRACE_PERIOD_SECONDS + 1) * 1000)
      const {token} = await setupUserWithRefreshToken(3600, "used", createdAt)
      const {plainToken, familyId} = token

      // When: Requesting refresh with used token
      const response = await request(app.getHttpServer()).post("/auth/cli/refresh").send({refreshToken: plainToken})

      // Expect error
      expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
      expect(response.body).toHaveErrorCode("REFRESH_TOKEN_REUSE_DETECTED")

      // Expect: The family is marked as revoked
      const family = await prisma.refreshToken.findMany({where: {familyId}})
      expect(family?.every(token => token.status === RefreshTokenStatus.REVOKED)).toBe(true)
    })
  })

  describe("POST /auth/web/refresh", () => {
    it("should return new tokens as HttpOnly cookies for valid refresh token", async () => {
      // Given: A user with a valid active refresh token
      const {token} = await setupUserWithRefreshToken()
      const {plainToken, tokenId} = token

      // When: Requesting refresh via web endpoint
      const response = await request(app.getHttpServer())
        .post("/auth/web/refresh")
        .set("Cookie", [`refresh_token=${plainToken}`])

      // Expect: the API call is successful with 204 No Content
      expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

      // Expect: new cookies are set
      expect(response.headers["set-cookie"]).toBeDefined()
      const setCookieHeaders = response.headers["set-cookie"] as unknown as string[]
      expect(setCookieHeaders.some(c => c.startsWith("access_token="))).toBeTruthy()
      expect(setCookieHeaders.some(c => c.startsWith("refresh_token="))).toBeTruthy()

      // Expect: the refresh token is marked as used
      const usedToken = await prisma.refreshToken.findUnique({where: {id: tokenId}})
      expect(usedToken?.status).toBe(RefreshTokenStatus.USED)
    })

    it("should return 400 for missing cookie", async () => {
      // When: Requesting refresh without cookie
      const response = await request(app.getHttpServer()).post("/auth/web/refresh")

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      expect(response.body).toHaveErrorCode("REQUEST_MISSING_REFRESH_TOKEN")
    })
  })

  describe("POST /auth/cli/initiate", () => {
    it("should redirect to OIDC provider and return auth URL", async () => {
      // Given: loopback redirect URI
      const redirectUri = "http://127.0.0.1:8080/callback"

      const response = await request(app.getHttpServer()).post("/auth/cli/initiate").send({redirectUri})

      expect(response).toHaveStatusCode(200)
      expect(response.body).toHaveProperty("authorizationUrl")

      const authUrl = response.body.authorizationUrl
      expect(authUrl).toContain("response_type=code")
      expect(authUrl).toContain("code_challenge=")
      expect(authUrl).toContain(encodeURIComponent(redirectUri))
    })

    it("should return 400 for non-loopback redirect URI", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/cli/initiate")
        .send({redirectUri: "https://example.com/callback"})

      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      expect(response.body).toHaveErrorCode("AUTH_INVALID_REDIRECT_URI")
    })
  })
})
