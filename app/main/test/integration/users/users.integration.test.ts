import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {PrismaClient} from "@prisma/client"

import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {createMockUserInDb as createMockUserFixture, createMockGroupInDb, MockConfigProvider} from "@test/mock-data"
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {get} from "@test/requests"
import {UserWithToken} from "@test/types"
import {v7 as uuidv7} from "uuid"
import {randomOrgId} from "@test/organization-id"
import {UserSummary, validateUser} from "@approvio/api"
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

  const createMockUserInDb = (prisma: PrismaClient, overrides?: Parameters<typeof createMockUserFixture>[1]) =>
    createMockUserFixture(prisma, {
      ...overrides,
      organizationId: overrides?.organizationId ?? orgAdminUser.user.organizationId
    })

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

  describe("GET /o/:organizationId/users/:userId", () => {
    it("returns the user details and a stable ETag", async () => {
      // Given
      const group = await createMockGroupInDb(prisma, {organizationId: orgAdminUser.user.organizationId})
      await prisma.groupMembership.create({
        data: {
          organizationId: group.organizationId,
          groupId: group.id,
          userId: orgMemberUser.user.id,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      })
      const userEndpoint = `${endpoint}/${orgMemberUser.user.id}`

      // When
      const response = await get(app, userEndpoint).withToken(orgAdminUser.token).build()
      const repeatedResponse = await get(app, userEndpoint).withToken(orgMemberUser.token).build()

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.OK)
      expect(validateUser(response.body)).toBeRight()
      expect(response.body).toMatchObject({
        id: orgMemberUser.user.id,
        organizationId: orgMemberUser.user.organizationId,
        accountId: orgMemberUser.user.accountId,
        displayName: orgMemberUser.user.displayName,
        orgRole: orgMemberUser.user.orgRole,
        roles: [],
        groups: [{groupId: group.id, groupName: group.name}]
      })
      expect(response.headers.etag).toBeDefined()
      expect(repeatedResponse).toHaveStatusCode(HttpStatus.OK)
      expect(repeatedResponse.headers.etag).toBe(response.headers.etag)
    })

    it("requires authentication", async () => {
      // When
      const response = await get(app, `${endpoint}/${orgMemberUser.user.id}`).build()

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
    })

    it("returns 404 for a missing user", async () => {
      // When
      const response = await get(app, `${endpoint}/${uuidv7()}`).withToken(orgAdminUser.token).build()

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
      expect(response.body).toHaveErrorCode("USER_NOT_FOUND")
    })

    it("does not return a user from another organization", async () => {
      // Given
      const otherUser = await createMockUserInDb(prisma, {organizationId: randomOrgId()})

      // When
      const response = await get(app, `${endpoint}/${otherUser.id}`).withToken(orgAdminUser.token).build()

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
      expect(response.body).toHaveErrorCode("USER_NOT_FOUND")
    })

    it("rejects an invalid user identifier", async () => {
      // When
      const response = await get(app, `${endpoint}/invalid`).withToken(orgAdminUser.token).build()

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      expect(response.body).toHaveErrorCode("REQUEST_INVALID_USER_IDENTIFIER")
    })
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

      it.each(["alice.smith@example.com", "ALICE.SMITH@EXAMPLE.COM"])(
        "should find an organization member by exact email %s",
        async search => {
          // Given
          const user = await createMockUserInDb(prisma, {
            displayName: "Alice Smith",
            email: "alice.smith@example.com"
          })
          await createMockUserInDb(prisma, {
            organizationId: randomOrgId(),
            displayName: "Other Alice",
            email: "alice.smith@example.com"
          })

          // When
          const response = await get(app, endpoint).withToken(orgAdminUser.token).query({search}).build()

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.users).toBeArrayOfSize(1)
          expect(response.body.users).toEqual([
            expect.objectContaining({id: user.id, organizationId: orgAdminUser.user.organizationId})
          ])
          expect(response.body.pagination.total).toBe(1)
        }
      )

      it("should not find an email belonging only to another organization", async () => {
        // Given
        await createMockUserInDb(prisma, {
          organizationId: randomOrgId(),
          email: "outside@example.com"
        })

        // When
        const response = await get(app, endpoint)
          .withToken(orgAdminUser.token)
          .query({search: "outside@example.com"})
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.users).toBeArrayOfSize(0)
        expect(response.body.pagination.total).toBe(0)
      })

      it("should paginate exact email matches within the organization", async () => {
        // Given
        const first = await createMockUserInDb(prisma, {displayName: "Alice", email: "shared@example.com"})
        const second = await createMockUserInDb(prisma, {displayName: "Bob", email: "shared@example.com"})
        await createMockUserInDb(prisma, {
          organizationId: randomOrgId(),
          displayName: "Other member",
          email: "shared@example.com"
        })

        // When
        const firstPage = await get(app, endpoint)
          .withToken(orgAdminUser.token)
          .query({search: "shared@example.com", page: 1, limit: 1})
          .build()
        const secondPage = await get(app, endpoint)
          .withToken(orgAdminUser.token)
          .query({search: "shared@example.com", page: 2, limit: 1})
          .build()

        // Expect
        expect(firstPage).toHaveStatusCode(HttpStatus.OK)
        expect(secondPage).toHaveStatusCode(HttpStatus.OK)
        expect(firstPage.body.users).toEqual([expect.objectContaining({id: first.id})])
        expect(secondPage.body.users).toEqual([expect.objectContaining({id: second.id})])
        expect(firstPage.body.pagination).toMatchObject({page: 1, limit: 1, total: 2})
        expect(secondPage.body.pagination).toMatchObject({page: 2, limit: 1, total: 2})
      })

      it("should not match users by email-domain substring", async () => {
        // Given
        await createMockUserInDb(prisma, {displayName: "Alice Smith", email: "alice.smith@example1.com"})
        await createMockUserInDb(prisma, {displayName: "Bob Johnson", email: "bob.j@example.com"})
        await createMockUserInDb(prisma, {displayName: "Charlie Brown", email: "charlie.b@example.com"})

        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).query({search: "@example.com"}).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.users).toBeArrayOfSize(0)
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
