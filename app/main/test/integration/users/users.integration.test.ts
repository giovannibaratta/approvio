import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {USERS_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient, User as PrismaUser} from "@prisma/client"
import {UserCreate} from "@approvio/api"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "../database"
import {createDomainMockUserInDb, createMockUserInDb, MockConfigProvider} from "../shared/mock-data"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {get, post} from "../shared/requests"
import {UserWithToken} from "../shared/types"
import {UserSummary} from "@approvio/api"
import "expect-more-jest"
import "@utils/matchers"
import {TokenPayloadBuilder} from "@services"

describe("Users API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken

  const endpoint = `/${USERS_ENDPOINT_ROOT}`

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication()
    prisma = module.get(DatabaseClient)
    const jwtService = module.get(JwtService)
    const configProvider = module.get(ConfigProvider)

    const adminUser = await createDomainMockUserInDb(prisma, {orgAdmin: true})
    const memberUser = await createDomainMockUserInDb(prisma, {orgAdmin: false})

    const adminTokenPayload = TokenPayloadBuilder.fromUser(adminUser, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })
    const memberTokenPayload = TokenPayloadBuilder.fromUser(memberUser, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })

    orgAdminUser = {user: adminUser, token: jwtService.sign(adminTokenPayload)}
    orgMemberUser = {user: memberUser, token: jwtService.sign(memberTokenPayload)}

    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
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

        // Should not be an admin
        const notOrgAdmin = await prisma.organizationAdmin.findMany({
          where: {email: userDbObject?.email}
        })
        expect(notOrgAdmin).toHaveLength(0)
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
        expect(response.body).toHaveErrorCode("USER_EMAIL_INVALID")
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
        expect(response.body).toHaveErrorCode("USER_DISPLAY_NAME_EMPTY")
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
        expect(response.body).toHaveErrorCode("USER_EMAIL_EMPTY")
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

      it("should return 400 BAD_REQUEST (REQUEST_INVALID_USER_IDENTIFIER) for invalid identifiers", async () => {
        // Given
        const invalidId = "not-a-uuid-and-not-an-email"

        // When
        const response = await get(app, `${endpoint}/${invalidId}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("REQUEST_INVALID_USER_IDENTIFIER")
      })
    })
  })

  describe(`GET ${endpoint}`, () => {
    describe("good cases", () => {
      it("should return a list of users (as OrgAdmin)", async () => {
        // Given
        const user1 = await createMockUserInDb(prisma, {email: "user1@example.com"})
        const user2 = await createMockUserInDb(prisma, {email: "user2@example.com"})

        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.users).toBeArray()
        // Check if the created users are in the response, without assuming order
        const responseUserIds = response.body.users.map((u: UserSummary) => u.id)
        expect(responseUserIds).toBeArrayOfSize(4) // accounts for admin and member user created in beforeEach
        expect(responseUserIds).toBeArrayIncludingAllOf([user1.id, user2.id])
      })

      it("should return users matching fuzzy display name search (as OrgAdmin)", async () => {
        // Given
        const user1 = await createMockUserInDb(prisma, {displayName: "Alice Smith", email: "alice.smith@example.com"})
        await createMockUserInDb(prisma, {displayName: "Bob Johnson", email: "bob.j@example.com"})
        await createMockUserInDb(prisma, {displayName: "Charlie Brown", email: "charlie.b@example.com"})

        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).query({search: "alic"}).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.users).toBeArrayOfSize(1)
        expect(response.body.users.map((u: UserSummary) => u.id)).toBeArrayIncludingOnly([user1.id])
      })

      it("should return users matching fuzzy email search (as OrgAdmin)", async () => {
        // Given
        await createMockUserInDb(prisma, {displayName: "Alice Smith", email: "alice.smith@example1.com"})
        const user2 = await createMockUserInDb(prisma, {displayName: "Bob Johnson", email: "bob.j@example.com"})
        const user3 = await createMockUserInDb(prisma, {displayName: "Charlie Brown", email: "charlie.b@example.com"})

        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).query({search: "@example.com"}).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.users).toBeArrayOfSize(2)
        const responseUserEmails = response.body.users.map((u: UserSummary) => u.email)
        expect(responseUserEmails).toBeArrayIncludingOnly([user2.email, user3.email])
      })

      it("should return users matching fuzzy display name search with spaces (as OrgAdmin)", async () => {
        // Given
        const user1 = await createMockUserInDb(prisma, {displayName: "John Smith", email: "john.smith@example.com"})
        await createMockUserInDb(prisma, {displayName: "Jane Doe", email: "jane.doe@example.com"})
        await createMockUserInDb(prisma, {displayName: "Bob Johnson", email: "bob.j@example.com"})

        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).query({search: "John S"}).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.users).toBeArrayOfSize(1)
        expect(response.body.users.map((u: UserSummary) => u.id)).toBeArrayIncludingOnly([user1.id])
      })

      it("should return a list of users (as OrgMember)", async () => {
        // When
        const response = await get(app, endpoint).withToken(orgMemberUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.users).toBeArray()
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When
        const response = await get(app, endpoint).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 400 BAD_REQUEST (SEARCH_TOO_LONG) for search queries exceeding 256 characters", async () => {
        // Given
        const longSearch = "a".repeat(101) // 257 characters

        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).query({search: longSearch}).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("SEARCH_TOO_LONG")
      })

      it("should return 400 BAD_REQUEST (SEARCH_TERM_INVALID_CHARACTERS) for search queries with invalid characters", async () => {
        // Given
        const invalidSearch = "user<script>alert('xss')</script>"

        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).query({search: invalidSearch}).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("SEARCH_TERM_INVALID_CHARACTERS")
      })

      it("should return 400 BAD_REQUEST (SEARCH_TERM_INVALID_CHARACTERS) for whitespace-only search queries", async () => {
        // Given
        const whitespaceSearch = "   "

        // When
        const response = await get(app, endpoint)
          .withToken(orgAdminUser.token)
          .query({search: whitespaceSearch})
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("SEARCH_TERM_INVALID_CHARACTERS")
      })
    })
  })
})
