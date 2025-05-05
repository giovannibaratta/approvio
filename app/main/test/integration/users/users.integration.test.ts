import {Test, TestingModule} from "@nestjs/testing"
import {Config} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {USERS_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient, User as PrismaUser} from "@prisma/client"
import {UserCreate} from "@api"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "../database"
import {createDomainMockUserInDb, createMockUserInDb} from "../shared/mock-data"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {OrgRole} from "@domain"
import {get, post} from "../shared/requests"
import {UserWithToken} from "../shared/types"

describe("Users API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken

  const endpoint = `/${USERS_ENDPOINT_ROOT}`

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(Config)
      .useValue({getDbConnectionUrl: () => isolatedDb})
      .compile()

    app = module.createNestApplication()
    prisma = module.get(DatabaseClient)
    const jwtService = module.get(JwtService)

    const adminUser = await createDomainMockUserInDb(prisma, {orgRole: OrgRole.ADMIN})
    const memberUser = await createDomainMockUserInDb(prisma, {orgRole: OrgRole.MEMBER})
    orgAdminUser = {user: adminUser, token: jwtService.sign({email: adminUser.email, sub: adminUser.id})}
    orgMemberUser = {user: memberUser, token: jwtService.sign({email: memberUser.email, sub: memberUser.id})}

    await app.init()
  })

  afterEach(async () => {
    cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  describe("POST /users", () => {
    const createUserPayload: UserCreate = {
      displayName: "Test User",
      email: "test.user@example.com",
      orgRole: "member"
    }

    describe("good cases", () => {
      it("should create a user and return 201 with location header (as OrgAdmin)", async () => {
        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(createUserPayload)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.headers.location).toMatch(new RegExp(`${endpoint}/[a-f0-9-]+`))

        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""

        // Validate side effects in DB
        const userDbObject = await prisma.user.findUnique({
          where: {id: responseUuid}
        })
        expect(userDbObject).toBeDefined()
        expect(userDbObject?.displayName).toEqual(createUserPayload.displayName)
        expect(userDbObject?.email).toEqual(createUserPayload.email)
        expect(userDbObject?.id).toEqual(responseUuid)
        expect(userDbObject?.orgRole).toEqual(OrgRole.MEMBER)
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When
        const response = await post(app, endpoint).build().send(createUserPayload)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 403 FORBIDDEN if requestor is not OrgAdmin", async () => {
        // When
        const response = await post(app, endpoint).withToken(orgMemberUser.token).build().send(createUserPayload)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
        expect(response.body).toHaveErrorCode("REQUESTOR_NOT_AUTHORIZED")
      })

      it("should return 409 CONFLICT (USER_ALREADY_EXISTS) for duplicate email", async () => {
        // Given
        const existingEmail = "duplicate@example.com"
        await createMockUserInDb(prisma, {email: existingEmail})
        const requestBody: UserCreate = {
          displayName: "Another User",
          email: existingEmail,
          orgRole: "member"
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body).toHaveErrorCode("USER_ALREADY_EXISTS")
      })

      it("should return 400 BAD_REQUEST (EMAIL_INVALID) for invalid email format", async () => {
        // Given
        const requestBody: UserCreate = {
          displayName: "Invalid Email User",
          email: "not-an-email",
          orgRole: "member"
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("EMAIL_INVALID")
      })

      it("should return 400 BAD_REQUEST (DISPLAY_NAME_EMPTY) for empty display name", async () => {
        // Given
        const requestBody: UserCreate = {
          displayName: "  ", // Whitespace only
          email: "valid.email2@example.com",
          orgRole: "member"
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("DISPLAY_NAME_EMPTY")
      })

      it("should return 400 BAD_REQUEST (EMAIL_EMPTY) for empty email", async () => {
        // Given
        const requestBody: UserCreate = {
          displayName: "Valid Name",
          email: "",
          orgRole: "member"
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("EMAIL_EMPTY")
      })
    })
  })

  describe(`GET ${endpoint}/:userIdentifier`, () => {
    let createdUser: PrismaUser

    beforeEach(async () => {
      createdUser = await createMockUserInDb(prisma)
    })

    describe("good cases", () => {
      it("should return user details when fetching by ID (as OrgAdmin)", async () => {
        // When
        const response = await get(app, `${endpoint}/${createdUser.id}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.id).toEqual(createdUser.id)
        expect(response.body.displayName).toEqual(createdUser.displayName)
        expect(response.body.email).toEqual(createdUser.email)
        expect(response.body.createdAt).toBeDefined()
      })

      it("should return user details when fetching by email (as OrgMember)", async () => {
        // When
        const response = await get(app, `${endpoint}/${createdUser.id}`).withToken(orgMemberUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.id).toEqual(createdUser.id)
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When
        const response = await get(app, `${endpoint}/${createdUser.id}`).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 404 NOT_FOUND (USER_NOT_FOUND) when fetching non-existent ID", async () => {
        // Given
        const nonExistentId = randomUUID()

        // When
        const response = await get(app, `${endpoint}/${nonExistentId}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("USER_NOT_FOUND")
      })

      it("should return 404 NOT_FOUND (USER_NOT_FOUND) when fetching non-existent email", async () => {
        // Given
        const nonExistentEmail = "not.found@example.com"

        // When
        const response = await get(app, `${endpoint}/${nonExistentEmail}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("USER_NOT_FOUND")
      })

      it("should return 400 BAD_REQUEST (INVALID_IDENTIFIER) for invalid identifiers", async () => {
        // Given
        const invalidId = "not-a-uuid-and-not-an-email"

        // When
        const response = await get(app, `${endpoint}/${invalidId}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("INVALID_IDENTIFIER")
      })
    })
  })
})
