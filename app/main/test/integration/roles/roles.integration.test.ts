import {Test} from "@nestjs/testing"
import {NestApplication} from "@nestjs/core"
import {HttpStatus} from "@nestjs/common"
import * as request from "supertest"
import {AppModule} from "@app/app.module"
import {createDomainMockUserInDb, MockConfigProvider} from "../shared/mock-data"
import {cleanDatabase, prepareDatabase} from "../database"
import {TokenPayloadBuilder} from "@services"
import {PrismaClient} from "@prisma/client"
import {ConfigProvider} from "@external/config"
import {JwtService} from "@nestjs/jwt"
import {DatabaseClient} from "@external"

describe("Roles Integration Tests", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
      .compile()

    app = moduleRef.createNestApplication()
    prisma = moduleRef.get(DatabaseClient)
    jwtService = moduleRef.get(JwtService)
    configProvider = moduleRef.get(ConfigProvider)

    await app.init()
  }, 30000)

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  describe("GET /roles", () => {
    describe("good cases", () => {
      it("should return list of role templates for authenticated user", async () => {
        // Given: A valid user exists in the database
        const user = await createDomainMockUserInDb(prisma, {orgAdmin: false, roles: []})

        const tokenPayload = TokenPayloadBuilder.from({
          sub: user.id,
          entityType: "user",
          displayName: user.displayName,
          email: user.email,
          issuer: configProvider.jwtConfig.issuer,
          audience: [configProvider.jwtConfig.audience]
        })
        const userToken = jwtService.sign(tokenPayload)

        // When: Making a request to list roles
        const response = await request(app.getHttpServer())
          .get("/roles")
          .set("Authorization", `Bearer ${userToken}`)
          .expect(200)

        // Then: Response should contain roles array with proper structure
        expect(response.body).toMatchObject({
          roles: expect.any(Array)
        })
        expect(response.body.roles.length).toBeGreaterThan(0)
        expect(response.body.roles[0]).toMatchObject({
          name: expect.any(String),
          permissions: expect.any(Array),
          scope: expect.any(String)
        })
      })
    })

    describe("bad cases", () => {
      it("should return 401 for unauthenticated requests", async () => {
        // Given: No authentication token

        // When: Making a request to list roles without token
        const response = await request(app.getHttpServer()).get("/roles")

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 401 for invalid token", async () => {
        // Given: Invalid token

        // When: Making a request with invalid token
        const response = await request(app.getHttpServer()).get("/roles").set("Authorization", "Bearer invalid-token")

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })
    })
  })
})
