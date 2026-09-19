import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {PrismaClient} from "@prisma/client"

import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {createMockUserInDb as createMockUserFixture, MockConfigProvider} from "@test/mock-data"
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {get} from "@test/requests"
import {UserWithToken} from "@test/types"
import {UserSummary} from "@approvio/api"
import "expect-more-jest"
import "@utils/matchers"

describe("Users API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider

  let endpoint: string

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

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
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)

    await app.init()
  }, 30000)

  beforeEach(async () => {
    orgAdminUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})
    orgMemberUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      orgAdmin: false,
      organizationId: orgAdminUser.user.organizationId
    })
    endpoint = `/o/${orgAdminUser.user.organizationId}/users`
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  describe("GET /o/:organizationId/users", () => {
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
        const user1 = await createMockUserInDb(prisma, {
          displayName: "VeryUnlkikelyNameToBeFound Smith",
          email: "veryunlkikelynametobefound.smith@example.com"
        })
        await createMockUserInDb(prisma, {displayName: "Bob Johnson", email: "bob.j@example.com"})
        await createMockUserInDb(prisma, {displayName: "Charlie Brown", email: "charlie.b@example.com"})

        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).query({search: "veryunlkikely"}).build()

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
