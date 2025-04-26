import * as request from "supertest"

import {AddGroupEntitiesRequest, GroupCreate, RemoveGroupEntitiesRequest} from "@api"
import {AppModule} from "@app/app.module"
import {EntityType, GROUPS_ENDPOINT_ROOT, Role} from "@controllers"
import {DatabaseClient} from "@external"
import {Config} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient, Group as PrismaGroup, User as PrismaUser} from "@prisma/client"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "../database"
import {createTestUser} from "../shared/mock-data"

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
  const endpoint = `/${GROUPS_ENDPOINT_ROOT}`

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
      it("should create a group and return 201 with location header", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "This-is-a-group",
          description: "A test description"
        }

        // When
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        // Expect
        expect(response.status).toBe(201)
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
      })

      it("should create a group with null description if not provided", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "No-Desc-Group"
        }

        // When
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        // Expect
        expect(response.status).toBe(201)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const groupDbObject = await prisma.group.findUnique({where: {id: responseUuid}})
        expect(groupDbObject?.description).toBeNull()
      })
    })

    describe("bad cases", () => {
      it("should return 409 CONFLICT (GROUP_ALREADY_EXISTS) if a group with the same name exists", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "Duplicate Group Name"
        }
        await createTestGroup(prisma, requestBody.name)

        // When
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        // Expect
        expect(response.status).toBe(409)
        expect(response.body).toHaveErrorCode("GROUP_ALREADY_EXISTS")
      })

      it("should return 400 BAD_REQUEST (NAME_EMPTY) if name is empty", async () => {
        const requestBody: GroupCreate = {
          name: " " // Whitespace only
        }
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("NAME_EMPTY")
      })
    })
  })

  describe(`GET ${endpoint}`, () => {
    describe("good cases", () => {
      it("should return an empty list and default pagination when no groups exist", async () => {
        // When
        const response = await request(app.getHttpServer()).get(endpoint)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.groups).toEqual([])
        expect(response.body.pagination).toEqual({
          total: 0,
          page: 1,
          limit: 20
        })
      })

      it("should return a list of groups with correct pagination", async () => {
        // Given: some groups
        const group1 = await createTestGroup(prisma, "Group 1")
        const group2 = await createTestGroup(prisma, "Group 2")
        const group3 = await createTestGroup(prisma, "Group 3")

        // When: Request the first page with limit 2
        const response = await request(app.getHttpServer()).get(`${endpoint}?page=1&limit=2`)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.groups).toHaveLength(2)
        // Assuming default order is insertion/creation time
        expect(response.body.groups.map((g: any) => g.id)).toEqual([group1.id, group2.id])
        expect(response.body.pagination).toEqual({
          total: 3,
          page: 1,
          limit: 2
        })

        // When: Request the second page
        const responsePage2 = await request(app.getHttpServer()).get(`${endpoint}?page=2&limit=2`)

        // Expect page 2
        expect(responsePage2).toHaveStatusCode(HttpStatus.OK)
        expect(responsePage2.body.groups).toHaveLength(1)
        expect(responsePage2.body.groups[0].id).toEqual(group3.id)
        expect(responsePage2.body.pagination).toEqual({
          total: 3,
          page: 2,
          limit: 2
        })
      })

      it("should cap limit at MAX_LIMIT", async () => {
        // Given
        const limit = 200

        // When
        const resOverLimit = await request(app.getHttpServer()).get(`${endpoint}?page=1&limit=${limit}`)

        // Expect
        expect(resOverLimit.body.pagination.limit).toEqual(100)
      })
    })
  })

  describe(`GET ${endpoint}/:groupIdentifier`, () => {
    describe("good cases", () => {
      it("should return group details when fetching by ID", async () => {
        // Given
        const createdGroup = await createTestGroup(prisma, "Specific Group", "Details here")

        // When
        const response = await request(app.getHttpServer()).get(`${endpoint}/${createdGroup.id}`)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.id).toEqual(createdGroup.id)
        expect(response.body.name).toEqual(createdGroup.name)
        expect(response.body.description).toEqual(createdGroup.description)
        expect(response.body.entitiesCount).toEqual(0) // No members added yet
        expect(response.body.createdAt).toBeDefined()
        expect(response.body.updatedAt).toBeDefined()
      })

      it("should return group details when fetching by name", async () => {
        // Given
        const groupName = "Fetch-By-Name-Group"
        const createdGroup = await createTestGroup(prisma, groupName, undefined)

        // When
        const response = await request(app.getHttpServer()).get(`${endpoint}/${groupName}`)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.id).toEqual(createdGroup.id)
        expect(response.body.name).toEqual(createdGroup.name)
        expect(response.body.description).toBeUndefined()
        expect(response.body.entitiesCount).toEqual(0)
      })
    })

    describe("bad cases", () => {
      it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) when fetching non-existent ID", async () => {
        // Given
        const nonExistentId = randomUUID()

        // When
        const response = await request(app.getHttpServer()).get(`${endpoint}/${nonExistentId}`)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
      })

      it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) when fetching non-existent name", async () => {
        // Given
        const nonExistentName = "non-existent-group-name"

        // When
        const response = await request(app.getHttpServer()).get(`${endpoint}/${nonExistentName}`)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
      })
    })
  })

  describe(`Group Membership Endpoints (${endpoint}/:groupId/entities)`, () => {
    let group: PrismaGroup
    let user1: PrismaUser
    let user2: PrismaUser
    let user3: PrismaUser
    const entitiesEndpoint = (groupId: string) => `${endpoint}/${groupId}/entities`

    beforeEach(async () => {
      // Create common resources for membership tests
      group = await createTestGroup(prisma, "Membership Test Group")
      user1 = await createTestUser(prisma, "User One", "user.one@mem.test")
      user2 = await createTestUser(prisma, "User Two", "user.two@mem.test")
      user3 = await createTestUser(prisma, "User Three", "user.three@mem.test")
    })

    describe(`POST ${endpoint}/:groupId/entities`, () => {
      describe("good cases", () => {
        it("should add multiple users to a group and return updated group details", async () => {
          // Given
          const requestBody: AddGroupEntitiesRequest = {
            entities: [
              {entity: {entityId: user1.id, entityType: EntityType.HUMAN}, role: Role.ADMIN},
              {entity: {entityId: user2.id, entityType: EntityType.HUMAN}, role: Role.APPROVER}
            ]
          }

          // When
          const response = await request(app.getHttpServer()).post(entitiesEndpoint(group.id)).send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.id).toEqual(group.id)
          expect(response.body.entitiesCount).toEqual(2)

          // Verify DB state
          const memberships = await prisma.groupMembership.findMany({where: {groupId: group.id}})
          expect(memberships).toHaveLength(2)
          expect(memberships).toEqual(
            expect.arrayContaining([
              expect.objectContaining({userId: user1.id, role: Role.ADMIN}),
              expect.objectContaining({userId: user2.id, role: Role.APPROVER})
            ])
          )
        })
      })

      describe("bad cases", () => {
        it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) if group does not exist", async () => {
          // Given
          const nonExistentGroupId = randomUUID()
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}, role: Role.ADMIN}]
          }

          // When
          const response = await request(app.getHttpServer())
            .post(entitiesEndpoint(nonExistentGroupId))
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
          expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
        })

        it("should return 400 BAD_REQUEST (USER_NOT_FOUND) if a user does not exist", async () => {
          // Expect
          const nonExistentUserId = randomUUID()
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: nonExistentUserId, entityType: EntityType.HUMAN}, role: Role.ADMIN}]
          }

          // When
          const response = await request(app.getHttpServer()).post(entitiesEndpoint(group.id)).send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(400)
          expect(response.body).toHaveErrorCode("USER_NOT_FOUND")
        })

        it("should return 400 BAD_REQUEST (INVALID_ROLE) if role is invalid", async () => {
          // Given
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}, role: "invalid-role"}]
          }

          // When
          const response = await request(app.getHttpServer()).post(entitiesEndpoint(group.id)).send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("INVALID_ROLE")
        })

        it("should return 409 CONFLICT (ENTITY_ALREADY_IN_GROUP) if user is already a member", async () => {
          // Given
          await prisma.groupMembership.create({
            data: {groupId: group.id, userId: user1.id, role: Role.ADMIN, createdAt: new Date(), updatedAt: new Date()}
          })

          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}, role: Role.APPROVER}]
          }

          // When
          const response = await request(app.getHttpServer()).post(entitiesEndpoint(group.id)).send(requestBody)

          // Expect
          expect(response.status).toBe(409)
          expect(response.body).toHaveErrorCode("ENTITY_ALREADY_IN_GROUP")
        })

        it("should return 400 BAD_REQUEST (INVALID_UUID) if groupId is not a UUID", async () => {
          // Given
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}, role: Role.ADMIN}]
          }

          // When
          const response = await request(app.getHttpServer()).post(entitiesEndpoint("not-a-uuid")).send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("INVALID_UUID")
        })
      })
    })

    describe(`GET ${endpoint}/:groupId/entities`, () => {
      beforeEach(async () => {
        // Add some members for GET tests
        await prisma.groupMembership.createMany({
          data: [
            {
              groupId: group.id,
              userId: user1.id,
              role: Role.ADMIN,
              createdAt: new Date(2023, 0, 1),
              updatedAt: new Date(2023, 0, 1)
            },
            {
              groupId: group.id,
              userId: user2.id,
              role: Role.APPROVER,
              createdAt: new Date(2023, 0, 2),
              updatedAt: new Date(2023, 0, 2)
            }
          ]
        })
      })

      describe("good cases", () => {
        it("should list members of a group with default pagination", async () => {
          // When
          const response = await request(app.getHttpServer()).get(entitiesEndpoint(group.id))
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.entities).toHaveLength(2)
          expect(response.body.pagination).toEqual({total: 2, page: 1, limit: 20})
          expect(response.body.entities).toEqual(
            expect.arrayContaining([
              expect.objectContaining({entity: {entityId: user1.id, entityType: EntityType.HUMAN}, role: Role.ADMIN}),
              expect.objectContaining({entity: {entityId: user2.id, entityType: EntityType.HUMAN}, role: Role.APPROVER})
            ])
          )
        })

        it("should list members with specific pagination", async () => {
          // Given
          await prisma.groupMembership.create({
            data: {
              groupId: group.id,
              userId: user3.id,
              role: Role.AUDITOR,
              createdAt: new Date(2023, 0, 3),
              updatedAt: new Date(2023, 0, 3)
            }
          })
          // When
          const response = await request(app.getHttpServer()).get(`${entitiesEndpoint(group.id)}?page=2&limit=2`)
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.entities).toHaveLength(1) // user3 should be on page 2
          expect(response.body.entities[0].entity.entityId).toEqual(user3.id)
          expect(response.body.pagination).toEqual({total: 3, page: 2, limit: 2})
        })

        it("should return empty list if group has no members", async () => {
          // Given
          const emptyGroup = await createTestGroup(prisma, "Empty Group")
          // When
          const response = await request(app.getHttpServer()).get(entitiesEndpoint(emptyGroup.id))
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.entities).toHaveLength(0)
          expect(response.body.pagination).toEqual({total: 0, page: 1, limit: 20})
        })
      })

      describe("bad cases", () => {
        it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) if group does not exist", async () => {
          // Given
          const nonExistentGroupId = randomUUID()
          // When
          const response = await request(app.getHttpServer()).get(entitiesEndpoint(nonExistentGroupId))
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
          expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
        })

        it("should return 400 BAD_REQUEST (INVALID_UUID) if groupId is not a UUID", async () => {
          // When
          const response = await request(app.getHttpServer()).get(entitiesEndpoint("not-a-uuid"))
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("INVALID_UUID")
        })
      })
    })

    describe(`DELETE ${endpoint}/:groupId/entities`, () => {
      beforeEach(async () => {
        // Add members for DELETE tests
        await prisma.groupMembership.createMany({
          data: [
            {groupId: group.id, userId: user1.id, role: Role.ADMIN, createdAt: new Date(), updatedAt: new Date()},
            {groupId: group.id, userId: user2.id, role: Role.APPROVER, createdAt: new Date(), updatedAt: new Date()}
          ]
        })
      })

      describe("good cases", () => {
        it("should remove specified users from the group and return updated group", async () => {
          // Given
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}}]
          }

          // When
          const response = await request(app.getHttpServer()).delete(entitiesEndpoint(group.id)).send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.id).toEqual(group.id)
          expect(response.body.entitiesCount).toEqual(1) // user2 should remain

          // Verify DB state
          const remainingMemberships = await prisma.groupMembership.findMany({where: {groupId: group.id}})
          expect(remainingMemberships).toHaveLength(1)
          expect(remainingMemberships[0]?.userId).toEqual(user2.id)
        })

        it("should remove multiple users", async () => {
          // Given
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [
              {entity: {entityId: user1.id, entityType: EntityType.HUMAN}},
              {entity: {entityId: user2.id, entityType: EntityType.HUMAN}}
            ]
          }
          // When
          const response = await request(app.getHttpServer()).delete(entitiesEndpoint(group.id)).send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.entitiesCount).toEqual(0)
          const remainingMemberships = await prisma.groupMembership.findMany({where: {groupId: group.id}})
          expect(remainingMemberships).toHaveLength(0)
        })

        it("should return OK if user is not in the group", async () => {
          // Given
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: user3.id, entityType: EntityType.HUMAN}}]
          } // user3 was not added
          // When
          const response = await request(app.getHttpServer()).delete(entitiesEndpoint(group.id)).send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
        })
      })

      describe("bad cases", () => {
        it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) if group does not exist", async () => {
          // Given
          const nonExistentGroupId = randomUUID()
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}}]
          }
          // When
          const response = await request(app.getHttpServer())
            .delete(entitiesEndpoint(nonExistentGroupId))
            .send(requestBody)
          // Expect
          expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
          expect(response.body).toHaveErrorCode("GROUP_NOT_FOUND")
        })

        it("should return 400 BAD_REQUEST (INVALID_UUID) if groupId is not a UUID", async () => {
          // Given
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: user1.id, entityType: EntityType.HUMAN}}]
          }
          // When
          const response = await request(app.getHttpServer()).delete(entitiesEndpoint("not-a-uuid")).send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("INVALID_UUID")
        })

        it("should return 400 BAD_REQUEST (INVALID_UUID) if entityId is not a UUID in body", async () => {
          // Given
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: "not-a-uuid", entityType: EntityType.HUMAN}}]
          }
          // When
          const response = await request(app.getHttpServer()).delete(entitiesEndpoint(group.id)).send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("INVALID_UUID")
        })
      })
    })
  })
})
