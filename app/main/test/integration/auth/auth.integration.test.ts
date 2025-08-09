import {Test, TestingModule} from "@nestjs/testing"
import {INestApplication} from "@nestjs/common"
import * as request from "supertest"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external/database"
import {cleanDatabase, prepareDatabase} from "../database"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider} from "../shared/mock-data"
import {PrismaClient} from "@prisma/client"

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

  describe("GET /auth/login", () => {
    it("should redirect to OIDC provider with PKCE parameters", async () => {
      const response = await request(app.getHttpServer()).get("/auth/login")

      expect(response.status).toBe(302)
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

      expect(response.status).toBe(302)
      expect(response.headers.location).toBe(`/auth/success?code=${testCode}&state=${testState}`)
    })

    it("should redirect to error if missing code or state", async () => {
      const response = await request(app.getHttpServer()).get("/auth/callback")

      expect(response.status).toBe(302)
      expect(response.headers.location).toBe("/auth/error")
    })
  })

  describe("GET /auth/success", () => {
    it("should return success message for stateless flow", async () => {
      const response = await request(app.getHttpServer()).get("/auth/success")

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        message: "Authentication successful. Use the code and state to generate a JWT token."
      })
    })
  })

  describe("GET /auth/error", () => {
    it("should return error message", async () => {
      const response = await request(app.getHttpServer()).get("/auth/error")

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        message: "Authentication failed. Please try again."
      })
    })
  })

  describe("POST /auth/token", () => {
    it("should return unauthorized without required parameters", async () => {
      const response = await request(app.getHttpServer()).post("/auth/token")

      expect(response.status).toBe(401)
    })

    it("should return unauthorized with invalid PKCE verification", async () => {
      const response = await request(app.getHttpServer()).post("/auth/token").send({
        code: "invalid-code",
        state: "invalid-state",
        codeVerifier: "invalid-verifier"
      })

      expect(response.status).toBe(401)
    })
  })

  describe("GET /auth/info", () => {
    it("should return unauthorized without authentication token", async () => {
      const response = await request(app.getHttpServer()).get("/auth/info")

      expect(response.status).toBe(401)
    })

    it("should return unauthorized with invalid authentication token", async () => {
      const response = await request(app.getHttpServer())
        .get("/auth/info")
        .set("Authorization", "Bearer invalid-jwt-token")

      expect(response.status).toBe(401)
    })
  })
})
