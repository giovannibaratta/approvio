import * as request from "supertest"
import {Test, TestingModule} from "@nestjs/testing"
import {Config} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {USERS_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient} from "@prisma/client"
import {UserCreate} from "@api"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "../database"
import {createTestUser} from "../shared/mock-data"
import {HttpStatus} from "@nestjs/common"

describe("Users API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  const endpoint = `/${USERS_ENDPOINT_ROOT}`

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(Config)
      .useValue({
        getDbConnectionUrl: () => isolatedDb
      })
      .compile()

    app = module.createNestApplication()
    await app.init()

    prisma = module.get(DatabaseClient)
    await cleanDatabase(prisma)
  })

  afterEach(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  describe(`POST ${endpoint}`, () => {
    describe("good cases", () => {
      it("should create a user and return 201 with location header", async () => {
        // Given
        const requestBody: UserCreate = {
          displayName: "Test User",
          email: "test.user@example.com"
        }

        // When
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.headers.location).toMatch(new RegExp(`${endpoint}/[a-f0-9-]+`))

        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""

        // Validate side effects in DB
        const userDbObject = await prisma.user.findUnique({
          where: {id: responseUuid}
        })
        expect(userDbObject).toBeDefined()
        expect(userDbObject?.displayName).toEqual(requestBody.displayName)
        expect(userDbObject?.email).toEqual(requestBody.email)
        expect(userDbObject?.id).toEqual(responseUuid)
      })
    })

    describe("bad cases", () => {
      it("should return 409 CONFLICT (USER_ALREADY_EXISTS) for duplicate email", async () => {
        // Given
        const existingEmail = "duplicate@example.com"
        await createTestUser(prisma, "Existing User", existingEmail)
        const requestBody: UserCreate = {
          displayName: "Another User",
          email: existingEmail
        }

        // When
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body).toHaveErrorCode("USER_ALREADY_EXISTS")
      })

      it("should return 400 BAD_REQUEST (EMAIL_INVALID) for invalid email format", async () => {
        // Given
        const requestBody: UserCreate = {
          displayName: "Invalid Email User",
          email: "not-an-email"
        }

        // When
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("EMAIL_INVALID")
      })

      it("should return 400 BAD_REQUEST (DISPLAY_NAME_EMPTY) for empty display name", async () => {
        // Given
        const requestBody: UserCreate = {
          displayName: "  ", // Whitespace only
          email: "valid.email@example.com"
        }

        // When
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("DISPLAY_NAME_EMPTY")
      })

      it("should return 400 BAD_REQUEST (EMAIL_EMPTY) for empty email", async () => {
        // Given
        const requestBody: UserCreate = {
          displayName: "Valid Name",
          email: ""
        }

        // When
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("EMAIL_EMPTY")
      })
    })
  })

  describe(`GET ${endpoint}/:userIdentifier`, () => {
    describe("good cases", () => {
      it("should return user details when fetching by ID", async () => {
        // Given
        const createdUser = await createTestUser(prisma, "Fetch Me", "fetch.me@example.com")

        // When
        const response = await request(app.getHttpServer()).get(`${endpoint}/${createdUser.id}`)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.id).toEqual(createdUser.id)
        expect(response.body.displayName).toEqual(createdUser.displayName)
        expect(response.body.email).toEqual(createdUser.email)
        expect(response.body.createdAt).toBeDefined()
      })

      it("should return user details when fetching by email", async () => {
        // Given
        const createdUser = await createTestUser(prisma, "Fetch Me By Email", "fetch.by.email@example.com")

        // When
        const response = await request(app.getHttpServer()).get(`${endpoint}/${createdUser.email}`)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.id).toEqual(createdUser.id)
        expect(response.body.displayName).toEqual(createdUser.displayName)
        expect(response.body.email).toEqual(createdUser.email)
      })
    })

    describe("bad cases", () => {
      it("should return 404 NOT_FOUND (USER_NOT_FOUND) when fetching non-existent ID", async () => {
        // Given
        const nonExistentId = randomUUID()

        // When
        const response = await request(app.getHttpServer()).get(`${endpoint}/${nonExistentId}`)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("USER_NOT_FOUND")
      })

      it("should return 404 NOT_FOUND (USER_NOT_FOUND) when fetching non-existent email", async () => {
        // Given
        const nonExistentEmail = "not.found@example.com"

        // When
        const response = await request(app.getHttpServer()).get(`${endpoint}/${nonExistentEmail}`)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("USER_NOT_FOUND")
      })

      it("should return 400 BAD_REQUEST (VALIDATION_ERROR) for invalid identifiers", async () => {
        // Given
        const invalidId = "not-a-uuid-and-not-an-email"

        // When
        const response = await request(app.getHttpServer()).get(`${endpoint}/${invalidId}`)

        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("INVALID_IDENTIFIER")
      })
    })
  })
})
