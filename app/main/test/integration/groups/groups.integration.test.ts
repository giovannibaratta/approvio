import {
  AddGroupEntitiesRequest,
  GroupCreate,
  ListGroupEntities200Response,
  ListGroups200Response,
  RemoveGroupEntitiesRequest,
  Group as GroupApi
} from "@approvio/api"
import {AppModule} from "@app/app.module"
import {EntityType, GROUPS_ENDPOINT_ROOT, Role} from "@controllers"
import {DESCRIPTION_MAX_LENGTH, OrgRole} from "@domain"
import {DatabaseClient} from "@external"
import {Config} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient, Group as PrismaGroup, User as PrismaUser} from "@prisma/client"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "../database"
import {createDomainMockUserInDb, createMockUserInDb} from "../shared/mock-data"
import {get, post, del} from "../shared/requests"
import {UserWithToken} from "../shared/types"
import {MAX_LIMIT} from "@services"

async function createTestGroup(prisma: PrismaClient, name: string, description?: string): Promise<PrismaGroup> {
  const group = await prisma.group.create({
    data: {
      id: randomUUID(),
      name: name,
      description: description,
      createdAt: new Date(),
      updatedAt: new Date(),
      occ: 1
    }
  })
  return group
}

describe("Groups API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let jwtService: JwtService

  const endpoint = `/${GROUPS_ENDPOINT_ROOT}`

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
    jwtService = module.get(JwtService)

    const adminUser = await createDomainMockUserInDb(prisma, {orgRole: OrgRole.ADMIN})
    const memberUser = await createDomainMockUserInDb(prisma, {orgRole: OrgRole.MEMBER})

    orgAdminUser = {user: adminUser, token: jwtService.sign({email: adminUser.email, sub: adminUser.id})}
    orgMemberUser = {user: memberUser, token: jwtService.sign({email: memberUser.email, sub: memberUser.id})}

    await app.init()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  it("should be defined", () => {
    expect(app).toBeDefined()
  })

  describe(`POST ${endpoint}`, () => {
    describe("good cases", () => {
      it("should create a group and return 201 with location header (as OrgAdmin)", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "This-is-a-group",
          description: "A test description"
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.headers.location).toMatch(new RegExp(`${endpoint}/[a-f0-9-]+`))

        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""

        // Validate side effects
        const groupDbObject = await prisma.group.findUnique({
          where: {id: responseUuid}
        })
        expect(groupDbObject).toBeDefined()
        expect(groupDbObject?.name).toEqual(requestBody.name)
        expect(groupDbObject?.description).toEqual(requestBody.description)
        expect(groupDbObject?.id).toEqual(responseUuid)

        // Also check owner membership was created
        const ownerMembership = await prisma.groupMembership.findUnique({
          where: {groupId_userId: {groupId: responseUuid, userId: orgAdminUser.user.id}}
        })
        expect(ownerMembership).toBeDefined()
        expect(ownerMembership?.role).toEqual(Role.OWNER)
      })

      it("should create a group with null description if not provided (as OrgAdmin)", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "No-Desc-Group"
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const groupDbObject = await prisma.group.findUnique({where: {id: responseUuid}})
        expect(groupDbObject?.description).toBeNull()
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        const requestBody: GroupCreate = {name: "Unauthorized-Group"}
        const response = await post(app, endpoint).build().send(requestBody)
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 409 CONFLICT (GROUP_ALREADY_EXISTS) if a group with the same name exists (as OrgAdmin)", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "Duplicate-Group-Name"
        }
        await createTestGroup(prisma, requestBody.name)

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body).toHaveErrorCode("GROUP_ALREADY_EXISTS")
      })

      it("should return 400 BAD_REQUEST (NAME_EMPTY) if name is empty (as OrgAdmin)", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: " " // Whitespace only
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_NAME_EMPTY")
      })

      it("should return 400 BAD_REQUEST (NAME_INVALID_CHARACTERS) if name contains invalid characters", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "group@1"
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_NAME_INVALID_CHARACTERS")
      })

      it("should return 400 BAD_REQUEST (NAME_INVALID_CHARACTERS) if name starts with a number", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "1group"
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_NAME_INVALID_CHARACTERS")
      })

      it("should return 400 BAD_REQUEST (NAME_INVALID_CHARACTERS) if name starts with a hyphen", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "-group"
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_NAME_INVALID_CHARACTERS")
      })

      it("should return 400 BAD_REQUEST (NAME_INVALID_CHARACTERS) if name ends with a hyphen", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "group-"
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_NAME_INVALID_CHARACTERS")
      })

      it("should return 400 BAD_REQUEST (DESCRIPTION_TOO_LONG) if description is too long (as OrgAdmin)", async () => {
        // Given
        const longDescription = "a".repeat(DESCRIPTION_MAX_LENGTH + 1)
        const requestBody: GroupCreate = {
          name: "Long-Desc-Group",
          description: longDescription
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_DESCRIPTION_TOO_LONG")
      })
    })
  })

  describe(`GET ${endpoint}`, () => {
    describe("good cases", () => {
      it("should return an empty list and default pagination when no groups exist (as OrgAdmin)", async () => {
        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListGroups200Response = response.body
        expect(body.groups).toEqual([])
        expect(body.pagination).toEqual({
          total: 0,
          page: 1,
          limit: 20
        })
      })

      it("should return an empty list if OrgMember is not part of any group", async () => {
        // Given: OrgMember is not added to any group yet
        await createTestGroup(prisma, "Group-Member-Is-Not-In")

        // When
        const response = await get(app, endpoint).withToken(orgMemberUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListGroups200Response = response.body
        expect(body.groups).toEqual([])
        expect(body.pagination).toEqual({
          total: 0, // Reflects only groups visible to member
          page: 1,
          limit: 20
        })
      })

      it("should return a list of all groups with correct pagination (as OrgAdmin)", async () => {
        // Given: some groups
        const group1 = await createTestGroup(prisma, "Group-1")
        const group2 = await createTestGroup(prisma, "Group-2")
        const group3 = await createTestGroup(prisma, "Group-3")

        // When: Request the first page with limit 2
        const response = await get(app, `${endpoint}?page=1&limit=2`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const bodyPage1: ListGroups200Response = response.body
        expect(bodyPage1.groups).toHaveLength(2)
        // Assuming default order is insertion/creation time ASC
        expect(bodyPage1.groups.map((g: GroupApi) => g.id)).toEqual([group1.id, group2.id])
        expect(bodyPage1.pagination).toEqual({
          total: 3,
          page: 1,
          limit: 2
        })

        // When: Request the second page
        const responsePage2 = await get(app, `${endpoint}?page=2&limit=2`).withToken(orgAdminUser.token).build()

        // Expect page 2
        expect(responsePage2).toHaveStatusCode(HttpStatus.OK)
        const bodyPage2: ListGroups200Response = responsePage2.body
        expect(bodyPage2.groups).toHaveLength(1)
        expect(bodyPage2.groups.map((g: GroupApi) => g.id)).toEqual([group3.id])
        expect(bodyPage2.pagination).toEqual({
          total: 3,
          page: 2,
          limit: 2
        })
      })

      it("should return only groups the OrgMember is part of", async () => {
        // Given: some groups and member is part of group2
        await createTestGroup(prisma, "Group-1")
        const group2 = await createTestGroup(prisma, "Group-2")

        // Add OrgMember to group2
        await prisma.groupMembership.create({
          data: {
            groupId: group2.id,
            userId: orgMemberUser.user.id,
            role: Role.APPROVER, // Role doesn't matter for listing
            createdAt: new Date(),
            updatedAt: new Date()
          }
        })

        // When
        const response = await get(app, `${endpoint}?limit=5`) // Get all in one page
          .withToken(orgMemberUser.token)
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListGroups200Response = response.body
        expect(body.groups).toHaveLength(1)
        expect(body.groups[0]?.id).toEqual(group2.id)
        expect(body.pagination).toEqual({
          total: 1, // Only sees 1 group
          page: 1,
          limit: 5
        })
      })

      it("should cap limit at MAX_LIMIT (as OrgAdmin)", async () => {
        // Given
        const limit = MAX_LIMIT + 1

        // When
        const response = await get(app, `${endpoint}?page=1&limit=${limit}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListGroups200Response = response.body
        expect(body.pagination.limit).toEqual(MAX_LIMIT)
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

  describe(`GET ${endpoint}/:groupIdentifier`, () => {
    describe("good cases", () => {
      it("should return group details when fetching by ID (as OrgAdmin)", async () => {
        // Given
        const createdGroup = await createTestGroup(prisma, "Specific-Group", "Details here")

        // When
        const response = await get(app, `${endpoint}/${createdGroup.id}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.id).toEqual(createdGroup.id)
        expect(response.body.name).toEqual(createdGroup.name)
        expect(response.body.description).toEqual(createdGroup.description)
        expect(response.body.entitiesCount).toEqual(0) // No members added yet
        expect(response.body.createdAt).toBeDefined()
        expect(response.body.updatedAt).toBeDefined()
      })

      it("should return group details when fetching by name (as OrgAdmin)", async () => {
        // Given
        const groupName = "Fetch-By-Name-Group"
        const createdGroup = await createTestGroup(prisma, groupName, undefined)

        // When
        const response = await get(app, `${endpoint}/${groupName}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.id).toEqual(createdGroup.id)
        expect(response.body.name).toEqual(createdGroup.name)
        expect(response.body.description).toBeUndefined()
        expect(response.body.entitiesCount).toEqual(0)
      })

      it("should return group details if OrgMember is a member of the group (fetching by ID)", async () => {
        // Given
        const createdGroup = await createTestGroup(prisma, "Member-Group")
        // Add OrgMember to the group
        await prisma.groupMembership.create({
          data: {
            groupId: createdGroup.id,
            userId: orgMemberUser.user.id,
            role: Role.ADMIN,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        })

        // When
        const response = await get(app, `${endpoint}/${createdGroup.id}`).withToken(orgMemberUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.id).toEqual(createdGroup.id)
        expect(response.body.name).toEqual(createdGroup.name)
        expect(response.body.entitiesCount).toEqual(1) // Includes the member
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        const createdGroup = await createTestGroup(prisma, "Unauthorized-Group")
        const response = await get(app, `${endpoint}/${createdGroup.id}`).build()
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 404 NOT_FOUND if OrgMember tries to fetch group they are not part of", async () => {
        // Given:  OrgMember is NOT part of the group
        const createdGroup = await createTestGroup(prisma, "Other-Group")

        // When
        const response = await get(app, `${endpoint}/${createdGroup.id}`).withToken(orgMemberUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
      })

      it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) when fetching non-existent ID (as OrgAdmin)", async () => {
        // Given
        const nonExistentId = randomUUID()

        // When
        const response = await get(app, `${endpoint}/${nonExistentId}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
      })

      it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) when fetching non-existent name (as OrgAdmin)", async () => {
        // Given
        const nonExistentName = "non-existent-group-name"

        // When
        const response = await get(app, `${endpoint}/${nonExistentName}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
      })
    })
  })

  describe("Group Membership Endpoints (/groups/:groupId/entities)", () => {
    let group: PrismaGroup
    let user1: PrismaUser
    let user2: PrismaUser
    const entitiesEndpoint = (groupId: string) => `${endpoint}/${groupId}/entities`

    beforeEach(async () => {
      // Create common resources for membership tests
      group = await createTestGroup(prisma, "Membership-Test-Group")
      // User1 is admin, User2 is member for auth tests
      user1 = await createMockUserInDb(prisma, {orgRole: OrgRole.ADMIN})
      user2 = await createMockUserInDb(prisma, {orgRole: OrgRole.MEMBER})

      await prisma.groupMembership.create({
        data: {
          groupId: group.id,
          userId: user1.id,
          role: Role.ADMIN,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      })

      await prisma.groupMembership.create({
        data: {
          groupId: group.id,
          userId: orgMemberUser.user.id,
          role: Role.APPROVER,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      })
    })

    describe("POST", () => {
      describe("good cases", () => {
        it("should add multiple users to a group and return updated group details (as OrgAdmin)", async () => {
          // Given
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: user2.id, entityType: EntityType.HUMAN}, role: Role.AUDITOR}]
          }

          // When
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.id).toEqual(group.id)
          expect(response.body.entitiesCount).toEqual(3)

          // Verify DB state AFTER request
          const memberships = await prisma.groupMembership.findMany({
            where: {groupId: group.id},
            orderBy: {role: "asc"}
          })
          expect(memberships).toHaveLength(3)
          expect(memberships.map(m => m.userId)).toEqual(
            expect.arrayContaining([user1.id, orgMemberUser.user.id, user2.id])
          )
        })

        it("should allow a Group Admin (user1) to add members", async () => {
          // Given
          const groupAdminToken = jwtService.sign({email: user1.email, sub: user1.id})
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: user2.id, entityType: EntityType.HUMAN}, role: Role.AUDITOR}]
          }

          // When
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(groupAdminToken)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.entitiesCount).toEqual(3)
        })
      })

      describe("bad cases", () => {
        it("should return 401 UNAUTHORIZED if no token is provided", async () => {
          const requestBody: AddGroupEntitiesRequest = {entities: []}
          const response = await post(app, entitiesEndpoint(group.id)).build().send(requestBody)
          expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
        })

        it("should return 403 FORBIDDEN if requestor is only an Approver (user2/orgMemberUser)", async () => {
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: user2.id, entityType: EntityType.HUMAN}, role: Role.AUDITOR}]
          }
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(orgMemberUser.token)
            .build()
            .send(requestBody)

          expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
          expect(response.body).toHaveErrorCode("REQUESTOR_NOT_AUTHORIZED")
        })

        it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) if group does not exist (as OrgAdmin)", async () => {
          // Given
          const nonExistentGroupId = randomUUID()
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}, role: Role.ADMIN}]
          }

          // When
          const response = await post(app, entitiesEndpoint(nonExistentGroupId))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
          expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
        })

        it("should return 400 BAD_REQUEST (USER_NOT_FOUND) if a user does not exist (as OrgAdmin)", async () => {
          // Given
          const nonExistentUserId = randomUUID()
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: nonExistentUserId, entityType: EntityType.HUMAN}, role: Role.ADMIN}]
          }

          // When
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("MEMBERSHIP_USER_NOT_FOUND")
        })

        it("should return 400 BAD_REQUEST (INVALID_ROLE) if role is invalid (as OrgAdmin)", async () => {
          // Given
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}, role: "invalid-role"}]
          }

          // When
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("MEMBERSHIP_INVALID_ROLE")
        })

        it("should return 409 CONFLICT (ENTITY_ALREADY_IN_GROUP) if user is already a member (as OrgAdmin)", async () => {
          // Given user1 is already a member (Group Admin)
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}, role: Role.APPROVER}] // Try adding again
          }

          // When
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
          expect(response.body).toHaveErrorCode("MEMBERSHIP_ENTITY_ALREADY_IN_GROUP")
        })

        it("should return 400 BAD_REQUEST (INVALID_UUID) if groupId is not a UUID (as OrgAdmin)", async () => {
          // Given
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}, role: Role.ADMIN}]
          }

          // When
          const response = await post(app, entitiesEndpoint("not-a-uuid"))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("REQUEST_INVALID_GROUP_UUID")
        })

        it("should return 400 BAD_REQUEST (INVALID_UUID) if entityId is not a UUID in body (as OrgAdmin)", async () => {
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: "not-a-uuid", entityType: EntityType.HUMAN}, role: Role.ADMIN}]
          }
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("REQUEST_INVALID_USER_UUID")
        })
      })
    })

    describe("GET", () => {
      describe("good cases", () => {
        it("should list members of a group with default pagination (as OrgAdmin)", async () => {
          // When
          const response = await get(app, entitiesEndpoint(group.id)).withToken(orgAdminUser.token).build()
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          const body: ListGroupEntities200Response = response.body
          expect(body.entities).toHaveLength(2)
          expect(body.pagination).toEqual({total: 2, page: 1, limit: 20})
          expect(body.entities).toEqual(
            expect.arrayContaining([
              expect.objectContaining({entity: {entityId: user1.id, entityType: EntityType.HUMAN}, role: Role.ADMIN}),
              expect.objectContaining({
                entity: {entityId: orgMemberUser.user.id, entityType: EntityType.HUMAN},
                role: Role.APPROVER
              })
            ])
          )
        })

        it("should allow Group Member (user2/Approver) to list members", async () => {
          // When
          const response = await get(app, entitiesEndpoint(group.id)).withToken(orgMemberUser.token).build()
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          const body: ListGroupEntities200Response = response.body
          expect(body.entities).toHaveLength(2)
          expect(body.pagination).toEqual({total: 2, page: 1, limit: 20})
        })

        it("should list members with specific pagination (as OrgAdmin)", async () => {
          // Given: Add user3 to test pagination
          await prisma.groupMembership.create({
            data: {
              groupId: group.id,
              userId: user2.id,
              role: Role.AUDITOR,
              createdAt: new Date(2023, 0, 3),
              updatedAt: new Date(2023, 0, 3)
            }
          })

          // When: page=2, limit=2
          const response = await get(app, `${entitiesEndpoint(group.id)}?page=2&limit=2`)
            .withToken(orgAdminUser.token)
            .build()
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          const body: ListGroupEntities200Response = response.body
          // Assuming default sort makes user3 appear on page 2
          expect(body.entities).toHaveLength(1)
          expect(body.entities[0]?.entity.entityId).toEqual(user2.id)
          expect(body.pagination).toEqual({total: 3, page: 2, limit: 2})
        })
      })

      describe("bad cases", () => {
        it("should return 401 UNAUTHORIZED if no token is provided", async () => {
          const response = await get(app, entitiesEndpoint(group.id)).build()
          expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
        })

        it("should return 404 NOT_FOUND if OrgMember tries to list members of a group they are not in", async () => {
          // Given
          const otherGroup = await createTestGroup(prisma, "Other-Group")
          // orgMemberUser (user2) is not in otherGroup

          // When
          const response = await get(app, entitiesEndpoint(otherGroup.id)).withToken(orgMemberUser.token).build()

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
          expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
        })

        it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) if group does not exist (as OrgAdmin)", async () => {
          // Given
          const nonExistentGroupId = randomUUID()
          // When
          const response = await get(app, entitiesEndpoint(nonExistentGroupId)).withToken(orgAdminUser.token).build()
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
          expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
        })

        it("should return 400 BAD_REQUEST (INVALID_UUID) if groupId is not a UUID (as OrgAdmin)", async () => {
          // When
          const response = await get(app, entitiesEndpoint("not-a-uuid")).withToken(orgAdminUser.token).build()
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("REQUEST_INVALID_GROUP_UUID")
        })

        it("should return 400 BAD_REQUEST (INVALID_PAGE) for page <= 0", async () => {
          const response = await get(app, `${entitiesEndpoint(group.id)}?page=0`)
            .withToken(orgAdminUser.token)
            .build()
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("INVALID_PAGE")
        })

        it("should return 400 BAD_REQUEST (INVALID_LIMIT) for limit <= 0", async () => {
          const response = await get(app, `${entitiesEndpoint(group.id)}?limit=0`)
            .withToken(orgAdminUser.token)
            .build()
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("INVALID_LIMIT")
        })
      })
    })

    describe(`DELETE ${entitiesEndpoint(":groupId")}`, () => {
      describe("good cases", () => {
        it("should remove specified users from the group and return updated group (as OrgAdmin)", async () => {
          // Given: user1 (Admin), user2 (Approver) are members
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}}]
          }

          // When
          const response = await del(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.id).toEqual(group.id)
          // Started with 2 members, removed 1 -> 1 left
          expect(response.body.entitiesCount).toEqual(1)

          // Verify DB state
          const remainingMemberships = await prisma.groupMembership.findMany({where: {groupId: group.id}})
          expect(remainingMemberships).toHaveLength(1)
          expect(remainingMemberships[0]?.userId).toEqual(orgMemberUser.user.id)
        })

        it("should allow Group Admin (user1) to remove members (user2)", async () => {
          // Given
          const groupAdminToken = jwtService.sign({email: user1.email, sub: user1.id})
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: orgMemberUser.user.id, entityType: EntityType.HUMAN}}]
          }

          // When
          const response = await del(app, entitiesEndpoint(group.id))
            .withToken(groupAdminToken)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.entitiesCount).toEqual(1)

          const remainingMemberships = await prisma.groupMembership.findMany({where: {groupId: group.id}})
          expect(remainingMemberships).toHaveLength(1)
          expect(remainingMemberships[0]?.userId).toEqual(user1.id)
        })

        it("should remove multiple users (as OrgAdmin)", async () => {
          // Given: user1, user2 are members
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [
              {entity: {entityId: user1.id, entityType: EntityType.HUMAN}},
              {entity: {entityId: orgMemberUser.user.id, entityType: EntityType.HUMAN}}
            ]
          }
          // When
          const response = await del(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.entitiesCount).toEqual(0)
          const remainingMemberships = await prisma.groupMembership.findMany({where: {groupId: group.id}})
          expect(remainingMemberships).toHaveLength(0)
        })

        it("should return BAD_REQUEST if user to remove is not in the group (as OrgAdmin)", async () => {
          // Given: user3 was not added
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: user2.id, entityType: EntityType.HUMAN}}]
          }
          // When
          const response = await del(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("MEMBERSHIP_NOT_FOUND")
        })
      })

      describe("bad cases", () => {
        it("should return 401 UNAUTHORIZED if no token is provided", async () => {
          const requestBody: RemoveGroupEntitiesRequest = {entities: []}
          const response = await del(app, entitiesEndpoint(group.id)).build().send(requestBody)
          expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
        })

        it("should return 403 FORBIDDEN if requestor is only an Approver (user2/orgMemberUser)", async () => {
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}}]
          }
          const response = await del(app, entitiesEndpoint(group.id))
            .withToken(orgMemberUser.token)
            .build()
            .send(requestBody)

          expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
          expect(response.body).toHaveErrorCode("REQUESTOR_NOT_AUTHORIZED")
        })

        it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) if group does not exist (as OrgAdmin)", async () => {
          // Given
          const nonExistentGroupId = randomUUID()
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}}]
          }
          // When
          const response = await del(app, entitiesEndpoint(nonExistentGroupId))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
          expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
        })

        it("should return 400 BAD_REQUEST (INVALID_UUID) if groupId is not a UUID (as OrgAdmin)", async () => {
          // Given
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}}]
          }
          // When
          const response = await del(app, entitiesEndpoint("not-a-uuid"))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("REQUEST_INVALID_GROUP_UUID")
        })

        it("should return 400 BAD_REQUEST (INVALID_UUID) if entityId is not a UUID in body (as OrgAdmin)", async () => {
          // Given
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: "not-a-uuid", entityType: EntityType.HUMAN}}]
          }
          // When
          const response = await del(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("REQUEST_INVALID_USER_UUID")
        })

        it("should return 400 BAD_REQUEST (membership_no_owner) if attempting to remove the last owner", async () => {
          // Given: group has one owner (user1) and one other member (orgMemberUser)
          // Ensure user1 is the only owner and orgMemberUser is not an owner.
          await prisma.groupMembership.deleteMany({where: {groupId: group.id}})
          await prisma.groupMembership.create({
            data: {
              groupId: group.id,
              userId: user1.id,
              role: Role.OWNER,
              createdAt: new Date(),
              updatedAt: new Date()
            }
          })
          await prisma.groupMembership.create({
            data: {
              groupId: group.id,
              userId: orgMemberUser.user.id,
              role: Role.APPROVER,
              createdAt: new Date(),
              updatedAt: new Date()
            }
          })

          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}}]
          }

          // When
          const response = await del(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("MEMBERSHIP_NO_OWNER")
        })

        it("should return 400 BAD_REQUEST (membership_no_owner) if attempting to remove the last member (who is also the only owner)", async () => {
          // Given: group has only one member who is also the owner
          await prisma.groupMembership.deleteMany({where: {groupId: group.id}})
          await prisma.groupMembership.create({
            data: {
              groupId: group.id,
              userId: user1.id,
              role: Role.OWNER,
              createdAt: new Date(),
              updatedAt: new Date()
            }
          })

          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}}]
          }

          // When
          const response = await del(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("MEMBERSHIP_NO_OWNER")
        })
      })
    })
  })
})
