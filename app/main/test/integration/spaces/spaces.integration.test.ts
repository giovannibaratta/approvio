import {SpaceCreate, ListSpaces200Response, Space as SpaceApi} from "@approvio/api"
import {AppModule} from "@app/app.module"
import {SPACES_ENDPOINT_ROOT} from "@controllers"
import {DatabaseClient} from "@external"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "../database"
import {createDomainMockUserInDb, MockConfigProvider, createMockSpaceInDb} from "../shared/mock-data"
import {get, post, del} from "../shared/requests"
import {UserWithToken} from "../shared/types"
import {TokenPayloadBuilder} from "@services"

describe("Spaces API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider

  const endpoint = `/${SPACES_ENDPOINT_ROOT}`

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

  describe("POST /spaces", () => {
    describe("good cases", () => {
      it("should create a space and return 201 with location header (as OrgAdmin)", async () => {
        // Given
        const requestBody: SpaceCreate = {
          name: "test-space",
          description: "A test space"
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.headers.location).toMatch(new RegExp(`${endpoint}/[a-f0-9-]+`))

        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""

        // Validate side effects
        const spaceDbObject = await prisma.space.findUnique({
          where: {id: responseUuid}
        })
        expect(spaceDbObject).toBeDefined()
        expect(spaceDbObject?.name).toEqual(requestBody.name)
        expect(spaceDbObject?.description).toEqual(requestBody.description)
        expect(spaceDbObject?.id).toEqual(responseUuid)

        // Also check user got manage permissions
        const updatedUser = await prisma.user.findUnique({
          where: {id: orgAdminUser.user.id}
        })
        expect(updatedUser?.roles).toBeDefined()
        const roles = updatedUser?.roles as unknown[]
        expect(roles).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "SpaceManager",
              permissions: ["read", "manage"],
              scope: expect.objectContaining({
                type: "space",
                spaceId: responseUuid
              })
            })
          ])
        )
      })

      it("should create a space with null description if not provided (as OrgMember)", async () => {
        // Given
        const requestBody: SpaceCreate = {
          name: "no-desc-space"
        }

        // When
        const response = await post(app, endpoint).withToken(orgMemberUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const spaceDbObject = await prisma.space.findUnique({where: {id: responseUuid}})
        expect(spaceDbObject?.description).toBeNull()
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        const requestBody: SpaceCreate = {name: "unauthorized-space"}
        const response = await post(app, endpoint).build().send(requestBody)
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 409 CONFLICT (SPACE_ALREADY_EXISTS) if a space with the same name exists", async () => {
        // Given
        const requestBody: SpaceCreate = {
          name: "duplicate-space"
        }
        await createMockSpaceInDb(prisma, {name: requestBody.name})

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body).toHaveErrorCode("SPACE_ALREADY_EXISTS")
      })

      it("should return 400 BAD_REQUEST (NAME_EMPTY) if name is empty", async () => {
        // Given
        const requestBody: SpaceCreate = {
          name: ""
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("SPACE_NAME_EMPTY")
      })
    })
  })

  describe("GET /spaces", () => {
    describe("good cases", () => {
      it("should return an empty list and default pagination when no spaces exist", async () => {
        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListSpaces200Response = response.body
        expect(body.data).toEqual([])
        expect(body.pagination).toEqual({
          total: 0,
          page: 1,
          limit: 20
        })
      })

      it("should return a list of all spaces with correct pagination", async () => {
        // Given: some spaces
        const space1 = await createMockSpaceInDb(prisma, {name: "space-1"})
        const space2 = await createMockSpaceInDb(prisma, {name: "space-2"})
        const space3 = await createMockSpaceInDb(prisma, {name: "space-3"})

        // When: Request the first page with limit 2
        const response = await get(app, `${endpoint}?page=1&limit=2`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const bodyPage1: ListSpaces200Response = response.body
        expect(bodyPage1.data).toHaveLength(2)
        expect(bodyPage1.data.map((s: SpaceApi) => s.id)).toEqual([space1.id, space2.id])
        expect(bodyPage1.pagination).toEqual({
          total: 3,
          page: 1,
          limit: 2
        })

        // When: Request the second page
        const responsePage2 = await get(app, `${endpoint}?page=2&limit=2`).withToken(orgAdminUser.token).build()

        // Expect page 2
        expect(responsePage2).toHaveStatusCode(HttpStatus.OK)
        const bodyPage2: ListSpaces200Response = responsePage2.body
        expect(bodyPage2.data).toHaveLength(1)
        expect(bodyPage2.data.map((s: SpaceApi) => s.id)).toEqual([space3.id])
        expect(bodyPage2.pagination).toEqual({
          total: 3,
          page: 2,
          limit: 2
        })
      })

      it("should cap limit at MAX_LIMIT", async () => {
        // Given
        const limit = 101

        // When
        const response = await get(app, `${endpoint}?page=1&limit=${limit}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListSpaces200Response = response.body
        expect(body.pagination.limit).toEqual(100)
      })

      it("should allow all authenticated users to list spaces (backdoor)", async () => {
        // Given: spaces exist
        await createMockSpaceInDb(prisma, {name: "public-space"})

        // When: Regular member lists spaces
        const response = await get(app, endpoint).withToken(orgMemberUser.token).build()

        // Expect: Can see all spaces
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListSpaces200Response = response.body
        expect(body.data).toHaveLength(1)
        expect(body.data[0]?.name).toEqual("public-space")
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        const response = await get(app, endpoint).build()
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 400 BAD_REQUEST (INVALID_PAGE) for page <= 0", async () => {
        const response = await get(app, `${endpoint}?page=0`).withToken(orgAdminUser.token).build()
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("INVALID_PAGE")
      })

      it("should return 400 BAD_REQUEST (INVALID_LIMIT) for limit <= 0", async () => {
        const response = await get(app, `${endpoint}?limit=-1`).withToken(orgAdminUser.token).build()
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("INVALID_LIMIT")
      })
    })
  })

  describe("GET /spaces/:spaceId", () => {
    describe("good cases", () => {
      it("should return space details when fetching by ID (as OrgAdmin)", async () => {
        // Given
        const createdSpace = await createMockSpaceInDb(prisma, {name: "specific-space", description: "Details here"})

        // When
        const response = await get(app, `${endpoint}/${createdSpace.id}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.id).toEqual(createdSpace.id)
        expect(response.body.name).toEqual(createdSpace.name)
        expect(response.body.description).toEqual(createdSpace.description)
        expect(response.body.createdAt).toBeDefined()
        expect(response.body.updatedAt).toBeDefined()
      })

      it("should return space details if user has read permissions on the space", async () => {
        // Given
        const createdSpace = await createMockSpaceInDb(prisma, {name: "read-accessible-space"})

        // Create user with read permission on this specific space
        const userWithReadPermission = await createDomainMockUserInDb(prisma, {
          orgAdmin: false,
          roles: [
            {
              name: "SpaceReader",
              permissions: ["read"],
              scope: {type: "space", spaceId: createdSpace.id}
            }
          ]
        })

        const tokenPayload = TokenPayloadBuilder.fromUserData({
          sub: userWithReadPermission.id,
          entityType: "user",
          displayName: userWithReadPermission.displayName,
          email: userWithReadPermission.email,
          issuer: configProvider.jwtConfig.issuer,
          audience: [configProvider.jwtConfig.audience]
        })
        const userToken = jwtService.sign(tokenPayload)

        // When
        const response = await get(app, `${endpoint}/${createdSpace.id}`).withToken(userToken).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.id).toEqual(createdSpace.id)
        expect(response.body.name).toEqual(createdSpace.name)
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        const createdSpace = await createMockSpaceInDb(prisma, {name: "unauthorized-space"})
        const response = await get(app, `${endpoint}/${createdSpace.id}`).build()
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 403 FORBIDDEN if user tries to fetch space without read permissions", async () => {
        // Given: Regular member has no specific permissions on the space
        const createdSpace = await createMockSpaceInDb(prisma, {name: "forbidden-space"})

        // When
        const response = await get(app, `${endpoint}/${createdSpace.id}`).withToken(orgMemberUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
        expect(response.body).toHaveErrorCode("REQUESTOR_NOT_AUTHORIZED")
      })

      it("should return 404 NOT_FOUND (SPACE_NOT_FOUND) when fetching non-existent ID", async () => {
        // Given
        const nonExistentId = randomUUID()

        // When
        const response = await get(app, `${endpoint}/${nonExistentId}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("SPACE_NOT_FOUND")
      })
    })
  })

  describe("DELETE /spaces/:spaceId", () => {
    describe("good cases", () => {
      it("should delete space successfully (as OrgAdmin)", async () => {
        // Given
        const createdSpace = await createMockSpaceInDb(prisma, {name: "deletable-space"})

        // When
        const response = await del(app, `${endpoint}/${createdSpace.id}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // Verify space is deleted
        const deletedSpace = await prisma.space.findUnique({where: {id: createdSpace.id}})
        expect(deletedSpace).toBeNull()
      })

      it("should allow user with manage permissions to delete space", async () => {
        // Given
        const createdSpace = await createMockSpaceInDb(prisma, {name: "manageable-space"})

        // Create user with manage permission on this specific space
        const userWithManagePermission = await createDomainMockUserInDb(prisma, {
          orgAdmin: false,
          roles: [
            {
              name: "SpaceManager",
              permissions: ["read", "manage"],
              scope: {type: "space", spaceId: createdSpace.id}
            }
          ]
        })

        const tokenPayload = TokenPayloadBuilder.fromUserData({
          sub: userWithManagePermission.id,
          entityType: "user",
          displayName: userWithManagePermission.displayName,
          email: userWithManagePermission.email,
          issuer: configProvider.jwtConfig.issuer,
          audience: [configProvider.jwtConfig.audience]
        })
        const userToken = jwtService.sign(tokenPayload)

        // When
        const response = await del(app, `${endpoint}/${createdSpace.id}`).withToken(userToken).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // Verify space is deleted
        const deletedSpace = await prisma.space.findUnique({where: {id: createdSpace.id}})
        expect(deletedSpace).toBeNull()
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        const createdSpace = await createMockSpaceInDb(prisma, {name: "unauthorized-delete"})
        const response = await del(app, `${endpoint}/${createdSpace.id}`).build()
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 403 FORBIDDEN if user tries to delete space without manage permissions", async () => {
        // Given: Regular member has no manage permissions on the space
        const createdSpace = await createMockSpaceInDb(prisma, {name: "forbidden-delete"})

        // When
        const response = await del(app, `${endpoint}/${createdSpace.id}`).withToken(orgMemberUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
        expect(response.body).toHaveErrorCode("REQUESTOR_NOT_AUTHORIZED")
      })

      it("should return 404 NOT_FOUND (SPACE_NOT_FOUND) when deleting non-existent space", async () => {
        // Given
        const nonExistentId = randomUUID()

        // When
        const response = await del(app, `${endpoint}/${nonExistentId}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("SPACE_NOT_FOUND")
      })
    })
  })
})
