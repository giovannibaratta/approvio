import {
  OrganizationAdminCreate,
  OrganizationAdminRemove,
  OrganizationAdmin as OrganizationAdminApi,
  Pagination as PaginationApi
} from "@approvio/api"
import {AppModule} from "@app/app.module"
import {ORGANIZATION_ADMIN_ENDPOINT_ROOT} from "@controllers"
import {DatabaseClient} from "@external"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {createDomainMockUserInDb, createMockUserInDb, MockConfigProvider} from "@test/mock-data"
import {get, post, del} from "@test/requests"
import {UserWithToken} from "@test/types"
import {TokenPayloadBuilder} from "@services"
import "expect-more-jest"
import "@utils/matchers"

describe("Organization Admin API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider

  const endpoint = `/${ORGANIZATION_ADMIN_ENDPOINT_ROOT}`
  const organizationName = "default"

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
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)

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

  it("should be defined", () => {
    expect(app).toBeDefined()
  })

  describe(`POST /${organizationName}/admins`, () => {
    describe("good cases", () => {
      it("should add organization admin with valid email and return 201 with location header", async () => {
        // Given
        const testUser = await createMockUserInDb(prisma, {email: "test.admin@example.com", orgAdmin: false})
        const requestBody: OrganizationAdminCreate = {
          email: testUser.email
        }

        // When
        const response = await post(app, `${endpoint}/${organizationName}/admins`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.headers.location).toMatch(new RegExp(`${endpoint}/${organizationName}/admins/[a-f0-9-]+`))

        const adminId: string = response.headers.location?.split("/").reverse()[0] ?? ""

        // Validate side effects
        const orgAdminDbObject = await prisma.organizationAdmin.findUnique({
          where: {id: adminId}
        })
        expect(orgAdminDbObject).toBeDefined()
        expect(orgAdminDbObject?.email).toEqual(requestBody.email)
        expect(orgAdminDbObject?.id).toEqual(adminId)
      })
    })

    describe("bad cases", () => {
      it("should return 400 for invalid email format", async () => {
        // Given
        const requestBody: OrganizationAdminCreate = {
          email: "invalid-email"
        }

        // When
        const response = await post(app, `${endpoint}/${organizationName}/admins`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for non-existent user email", async () => {
        // Given
        const requestBody: OrganizationAdminCreate = {
          email: "nonexistent@example.com"
        }

        // When
        const response = await post(app, `${endpoint}/${organizationName}/admins`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 409 for already existing organization admin", async () => {
        // Given
        const testEmail = "existing.admin@example.com"
        await createMockUserInDb(prisma, {email: testEmail, orgAdmin: true})
        const requestBody: OrganizationAdminCreate = {
          email: testEmail
        }

        // When
        const response = await post(app, `${endpoint}/${organizationName}/admins`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
      })

      it("should return 403 for unauthorized user (non-admin)", async () => {
        // Given
        const testUser = await createMockUserInDb(prisma, {email: "test.admin@example.com", orgAdmin: false})
        const requestBody: OrganizationAdminCreate = {
          email: testUser.email
        }

        // When
        const response = await post(app, `${endpoint}/${organizationName}/admins`)
          .withToken(orgMemberUser.token)
          .build()
          .send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      })

      it("should return 404 for invalid organization name", async () => {
        // Given
        const testUser = await createMockUserInDb(prisma, {email: "test.admin@example.com", orgAdmin: false})
        const requestBody: OrganizationAdminCreate = {
          email: testUser.email
        }

        // When
        const response = await post(app, `${endpoint}/invalid-org/admins`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
      })
    })
  })

  describe(`GET /${organizationName}/admins`, () => {
    describe("good cases", () => {
      it("should list organization admins with default pagination", async () => {
        // Given
        const testAdmin1 = await createMockUserInDb(prisma, {email: "admin1@example.com", orgAdmin: true})
        const testAdmin2 = await createMockUserInDb(prisma, {email: "admin2@example.com", orgAdmin: true})

        // When
        const response = await get(app, `${endpoint}/${organizationName}/admins`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body).toHaveProperty("data")
        expect(response.body).toHaveProperty("pagination")

        const data: OrganizationAdminApi[] = response.body.data
        const pagination: PaginationApi = response.body.pagination

        expect(data).toHaveLength(3) // 2 test admins + 1 setup admin
        expect(pagination.total).toBe(3)
        expect(pagination.page).toBe(1)
        expect(pagination.limit).toBe(20) // DEFAULT_LIMIT

        // Verify the test admin data is included
        const emails = data.map(admin => admin.email).sort()
        expect(emails).toContain(testAdmin1.email)
        expect(emails).toContain(testAdmin2.email)
      })

      it("should list organization admins with custom pagination", async () => {
        // Given
        await createMockUserInDb(prisma, {email: "admin1@example.com", orgAdmin: true})
        await createMockUserInDb(prisma, {email: "admin2@example.com", orgAdmin: true})
        await createMockUserInDb(prisma, {email: "admin3@example.com", orgAdmin: true})

        // When
        const response = await get(app, `${endpoint}/${organizationName}/admins?page=2&limit=1`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)

        const data: OrganizationAdminApi[] = response.body.data
        const pagination: PaginationApi = response.body.pagination

        expect(data).toHaveLength(1) // Only 1 item per page
        expect(pagination.total).toBe(4) // 3 test admins + 1 setup admin
        expect(pagination.page).toBe(2)
        expect(pagination.limit).toBe(1)
      })

      it("should return empty list when no admins exist", async () => {
        // Given: No organization admins created

        // When
        const response = await get(app, `${endpoint}/${organizationName}/admins`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)

        const data: OrganizationAdminApi[] = response.body.data
        const pagination: PaginationApi = response.body.pagination

        expect(data).toHaveLength(1) // Only setup admin exists
        expect(pagination.total).toBe(1)
        expect(pagination.page).toBe(1)
        expect(pagination.limit).toBe(20)
      })
    })

    describe("bad cases", () => {
      it("should return 400 for invalid page number", async () => {
        // Given: Invalid page parameter

        // When
        const response = await get(app, `${endpoint}/${organizationName}/admins?page=0`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for invalid limit number", async () => {
        // Given: Invalid limit parameter

        // When
        const response = await get(app, `${endpoint}/${organizationName}/admins?limit=101`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for non-numeric page parameter", async () => {
        // Given: Non-numeric page parameter

        // When
        const response = await get(app, `${endpoint}/${organizationName}/admins?page=abc`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body.message).toContain("Page and limit must be valid numbers")
      })

      it("should return 400 for non-numeric limit parameter", async () => {
        // Given: Non-numeric limit parameter

        // When
        const response = await get(app, `${endpoint}/${organizationName}/admins?limit=xyz`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body.message).toContain("Page and limit must be valid numbers")
      })

      it("should return 404 for invalid organization name", async () => {
        // Given: Invalid organization name

        // When
        const response = await get(app, `${endpoint}/invalid-org/admins`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
      })
    })
  })

  describe(`DELETE /${organizationName}/admins`, () => {
    describe("good cases", () => {
      it("should remove organization admin by UUID and return 204", async () => {
        // Given
        const testUser = await createMockUserInDb(prisma, {email: "admin.to.remove@example.com", orgAdmin: true})
        const requestBody: OrganizationAdminRemove = {
          userId: testUser.id // Using UUID
        }

        // When
        const response = await del(app, `${endpoint}/${organizationName}/admins`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // Validate side effects - admin should be removed
        const orgAdminDbObject = await prisma.organizationAdmin.findUnique({
          where: {email: testUser.email}
        })
        expect(orgAdminDbObject).toBeNull()
      })

      it("should remove organization admin by email and return 204", async () => {
        // Given
        const testEmail = "admin.to.remove.by.email@example.com"
        const testUser = await createMockUserInDb(prisma, {email: testEmail, orgAdmin: true})
        const requestBody: OrganizationAdminRemove = {
          userId: testEmail // Using email as identifier
        }

        // When
        const response = await del(app, `${endpoint}/${organizationName}/admins`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // Validate side effects - admin should be removed
        const orgAdminDbObject = await prisma.organizationAdmin.findUnique({
          where: {email: testUser.email}
        })
        expect(orgAdminDbObject).toBeNull()
      })

      it("should return 204 for idempotent removal (admin doesn't exist)", async () => {
        // Given
        const nonExistentId = randomUUID()
        const requestBody: OrganizationAdminRemove = {
          userId: nonExistentId
        }

        // When
        const response = await del(app, `${endpoint}/${organizationName}/admins`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect - Should be idempotent (204 even if doesn't exist)
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)
      })

      it("should return 204 for idempotent removal by email (admin doesn't exist)", async () => {
        // Given
        const nonExistentEmail = "nonexistent@example.com"
        const requestBody: OrganizationAdminRemove = {
          userId: nonExistentEmail
        }

        // When
        const response = await del(app, `${endpoint}/${organizationName}/admins`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect - Should be idempotent (204 even if doesn't exist)
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)
      })
    })

    describe("bad cases", () => {
      it("should return 400 for invalid identifier format (neither UUID nor email)", async () => {
        // Given
        const requestBody: OrganizationAdminRemove = {
          userId: "invalid-identifier-123" // Neither UUID nor email format
        }

        // When
        const response = await del(app, `${endpoint}/${organizationName}/admins`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body.message).toContain("Identifier must be a valid UUID or email address")
      })

      it("should return 403 for unauthorized user (non-admin)", async () => {
        // Given
        const testUser = await createMockUserInDb(prisma, {email: "admin.to.remove@example.com", orgAdmin: true})
        const requestBody: OrganizationAdminRemove = {
          userId: testUser.id
        }

        // When
        const response = await del(app, `${endpoint}/${organizationName}/admins`)
          .withToken(orgMemberUser.token)
          .build()
          .send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)

        // Validate side effects - admin should still exist
        const orgAdminDbObject = await prisma.organizationAdmin.findUnique({
          where: {email: testUser.email}
        })
        expect(orgAdminDbObject).toBeDefined()
      })

      it("should return 404 for invalid organization name", async () => {
        // Given
        const testUser = await createMockUserInDb(prisma, {email: "admin.to.remove@example.com", orgAdmin: true})
        const requestBody: OrganizationAdminRemove = {
          userId: testUser.id
        }

        // When
        const response = await del(app, `${endpoint}/invalid-org/admins`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)

        // Validate side effects - admin should still exist
        const orgAdminDbObject = await prisma.organizationAdmin.findUnique({
          where: {email: testUser.email}
        })
        expect(orgAdminDbObject).toBeDefined()
      })
    })
  })
})
