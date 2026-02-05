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

    app = module.createNestApplication()
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

  describe("GET /auth/login", () => {
    it("should redirect to OIDC provider with PKCE parameters", async () => {
      const response = await request(app.getHttpServer()).get("/auth/login")

      expect(response).toHaveStatusCode(302)
      const location = response.headers.location
      expect(location).toContain("response_type=code")
      expect(location).toContain("code_challenge=")
      expect(location).toContain("code_challenge_method=S256")
      expect(location).toContain("state=")
    })
  })

  describe("GET /auth/callback", () => {
    it("should redirect to success with code and state", async () => {
      const testCode = "test-auth-code"
      const testState = "test-state"

      const response = await request(app.getHttpServer())
        .get("/auth/callback")
        .query({code: testCode, state: testState})

      expect(response).toHaveStatusCode(HttpStatus.FOUND)
      expect(response.headers.location).toBe(`/auth/success?code=${testCode}&state=${testState}`)
    })

    it("should redirect to error if missing code or state", async () => {
      const response = await request(app.getHttpServer()).get("/auth/callback")

      expect(response).toHaveStatusCode(HttpStatus.FOUND)
      expect(response.headers.location).toBe("/auth/error")
    })
  })

  describe("GET /auth/success", () => {
    it("should return success message for stateless flow", async () => {
      const response = await request(app.getHttpServer()).get("/auth/success?code=123&state=456")

      expect(response).toHaveStatusCode(200)
      expect(response.body).toMatchObject({
        message: "Authentication successful. Use the code and state to generate a JWT token.",
        code: expect.toBeString(),
        state: expect.toBeString(),
        b64encoded: expect.toBeString()
      })
    })
  })

  describe("GET /auth/error", () => {
    it("should return error message", async () => {
      const response = await request(app.getHttpServer()).get("/auth/error")

      expect(response).toHaveStatusCode(200)
      expect(response.body).toEqual({
        message: "Authentication failed. Please try again."
      })
    })
  })

  describe("POST /auth/token", () => {
    it("should return unauthorized without required parameters", async () => {
      // When: No required parameters
      const response = await request(app.getHttpServer()).post("/auth/token")

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
    })

    it("should return unauthorized with invalid PKCE verification", async () => {
      const response = await request(app.getHttpServer()).post("/auth/token").send({
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
        .post("/auth/refresh")
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
        .post("/auth/refresh")
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

  describe("POST /auth/refresh", () => {
    it("should return new tokens for valid refresh token", async () => {
      // Given: A user with a valid active refresh token
      const {token} = await setupUserWithRefreshToken()
      const {plainToken, tokenId} = token

      // When: Requesting refresh
      const response = await request(app.getHttpServer()).post("/auth/refresh").send({refreshToken: plainToken})

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
      const response = await request(app.getHttpServer()).post("/auth/refresh").send({refreshToken: plainToken})

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
      const response = await request(app.getHttpServer()).post("/auth/refresh").send({refreshToken: plainToken})

      // Expect error
      expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
      expect(response.body).toHaveErrorCode("REFRESH_TOKEN_REUSE_DETECTED")

      // Expect: The family is marked as revoked
      const family = await prisma.refreshToken.findMany({where: {familyId}})
      expect(family?.every(token => token.status === RefreshTokenStatus.REVOKED)).toBe(true)
    })
  })
})
