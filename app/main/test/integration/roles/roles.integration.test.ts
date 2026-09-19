import {Test} from "@nestjs/testing"
import {NestApplication} from "@nestjs/core"
import {HttpStatus} from "@nestjs/common"
import request from "supertest"
import {AppModule} from "@app/app.module"
import {MockConfigProvider} from "@test/mock-data"
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {PrismaClient} from "@prisma/client"
import {ConfigProvider} from "@external/config"
import {JwtService} from "@nestjs/jwt"
import {get} from "@test/requests"
import {v7 as uuidv7} from "uuid"

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
      .useValue(MockConfigProvider.fromOriginalProvider({tenantConnectionUrl: isolatedDb}))
      .compile()

    app = moduleRef.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(isolatedDb)
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

  describe("GET /o/:organizationId/roles", () => {
    describe("good cases", () => {
      it("should return list of role templates for authenticated user", async () => {
        // Given: A valid user exists in the database
        const {token: userToken, user} = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
          orgAdmin: false,
          roles: []
        })

        // When: Making a request to list roles
        const response = await request(app.getHttpServer())
          .get(`/o/${user.organizationId}/roles`)
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
        const organizationId = uuidv7()
        const response = await request(app.getHttpServer()).get(`/o/${organizationId}/roles`)

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return BAD REQUEST for invalid token", async () => {
        // Given: Invalid token
        const invalidToken = "invalid-jwt-token"

        // When: Making a request with invalid token
        const organizationId = uuidv7()
        const response = await get(app, `/o/${organizationId}/roles`).withToken(invalidToken).build().send()

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })
    })
  })
})
