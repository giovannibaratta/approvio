import {AddGroupEntitiesRequest, ListGroupEntities200Response, RemoveGroupEntitiesRequest} from "@approvio/api"
import {AppModule} from "@app/app.module"
import {GROUPS_ENDPOINT_ROOT} from "@controllers"
import {DatabaseClient} from "@external"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient, Group as PrismaGroup, Agent as PrismaAgent} from "@prisma/client"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {createDomainMockUserInDb, createMockAgentInDb, createTestGroup, MockConfigProvider} from "@test/mock-data"
import {get, post, del} from "@test/requests"
import {UserWithToken} from "@test/types"
import {TokenPayloadBuilder} from "@services"
import {mapAgentToDomain} from "@external/database/shared"
import {isLeft} from "fp-ts/lib/Either"
import {EntityType} from "@controllers/groups/groups.mappers"

type AgentWithToken = {
  agent: PrismaAgent
  token: string
}

describe("Groups API - Agent Membership", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let testAgent: AgentWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider

  const endpoint = `/${GROUPS_ENDPOINT_ROOT}`

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
    const agent = await createMockAgentInDb(prisma, {agentName: "test-group-agent"})
    const domainAgent = mapAgentToDomain(agent)

    if (isLeft(domainAgent)) throw new Error("Failed to init agent mock")

    const adminTokenPayload = TokenPayloadBuilder.fromUser(adminUser, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })
    const memberTokenPayload = TokenPayloadBuilder.fromUser(memberUser, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })

    // Create agent token payload - agents should have entityType: "agent"
    const agentTokenPayload = TokenPayloadBuilder.fromAgent(domainAgent.right, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })

    orgAdminUser = {user: adminUser, token: jwtService.sign(adminTokenPayload)}
    orgMemberUser = {user: memberUser, token: jwtService.sign(memberTokenPayload)}
    testAgent = {agent, token: jwtService.sign(agentTokenPayload)}

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

  describe("Agent Group Membership Endpoints (/groups/:groupId/entities)", () => {
    let group: PrismaGroup
    let agent1: PrismaAgent
    let agent2: PrismaAgent
    const entitiesEndpoint = (groupId: string) => `${endpoint}/${groupId}/entities`

    beforeEach(async () => {
      // Create common resources for membership tests
      group = await createTestGroup(prisma, {name: "Agent-Membership-Test-Group"})
      agent1 = await createMockAgentInDb(prisma, {agentName: "test-agent-1"})
      agent2 = await createMockAgentInDb(prisma, {agentName: "test-agent-2"})
    })

    describe("POST", () => {
      describe("good cases", () => {
        it("should add single agent to a group and return updated group details (as OrgAdmin)", async () => {
          // Given
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}]
          }

          // When
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.id).toEqual(group.id)
          expect(response.body.entitiesCount).toEqual(1)
        })

        it("should add multiple agents to a group (as OrgAdmin)", async () => {
          // Given
          const requestBody: AddGroupEntitiesRequest = {
            entities: [
              {entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}},
              {entity: {entityId: agent2.id, entityType: EntityType.SYSTEM}}
            ]
          }

          // When
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.id).toEqual(group.id)
          expect(response.body.entitiesCount).toEqual(2)
        })

        it("should allow mixed entities (users and agents) in same request (as OrgAdmin)", async () => {
          // Given
          const requestBody: AddGroupEntitiesRequest = {
            entities: [
              {entity: {entityId: orgMemberUser.user.id, entityType: EntityType.HUMAN}},
              {entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}
            ]
          }

          // When
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.id).toEqual(group.id)
          expect(response.body.entitiesCount).toEqual(2)
        })
      })

      describe("bad cases", () => {
        it("should return 401 UNAUTHORIZED if no token is provided", async () => {
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}]
          }
          const response = await post(app, entitiesEndpoint(group.id)).build().send(requestBody)
          expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
        })

        it("should return 403 FORBIDDEN if agent tries to add other agents", async () => {
          // Given
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: agent2.id, entityType: EntityType.SYSTEM}}]
          }

          // When
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(testAgent.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
          expect(response.body).toHaveErrorCode("REQUESTOR_NOT_AUTHORIZED")
        })

        it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) if group does not exist (as OrgAdmin)", async () => {
          // Given
          const nonExistentGroupId = randomUUID()
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}]
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

        it("should return 400 BAD_REQUEST (AGENT_NOT_FOUND) if an agent does not exist (as OrgAdmin)", async () => {
          // Given
          const nonExistentAgentId = randomUUID()
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: nonExistentAgentId, entityType: EntityType.SYSTEM}}]
          }

          // When
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("AGENT_NOT_FOUND")
        })

        it("should return 409 CONFLICT (ENTITY_ALREADY_IN_GROUP) if agent is already a member (as OrgAdmin)", async () => {
          // Given: Add agent to group first
          await prisma.agentGroupMembership.create({
            data: {
              groupId: group.id,
              agentId: agent1.id,
              createdAt: new Date(),
              updatedAt: new Date()
            }
          })

          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}]
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
            entities: [{entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}]
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

        it("should return 400 BAD_REQUEST (INVALID_UUID) if agentId is not a UUID in body (as OrgAdmin)", async () => {
          const requestBody: AddGroupEntitiesRequest = {
            entities: [{entity: {entityId: "not-a-uuid", entityType: EntityType.SYSTEM}}]
          }
          const response = await post(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("REQUEST_INVALID_ENTITY_UUID")
        })
      })
    })

    describe("GET", () => {
      describe("good cases", () => {
        it("should list agents in a group with correct entityType (as OrgAdmin)", async () => {
          // Given: Add agents to group
          await prisma.agentGroupMembership.createMany({
            data: [
              {
                groupId: group.id,
                agentId: agent1.id,
                createdAt: new Date(),
                updatedAt: new Date()
              },
              {
                groupId: group.id,
                agentId: agent2.id,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            ]
          })

          // When
          const response = await get(app, entitiesEndpoint(group.id)).withToken(orgAdminUser.token).build()

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          const body: ListGroupEntities200Response = response.body
          expect(body.entities).toHaveLength(2)
          expect(body.pagination).toEqual({total: 2, page: 1, limit: 20})
          expect(body.entities).toEqual(
            expect.arrayContaining([
              expect.objectContaining({entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}),
              expect.objectContaining({entity: {entityId: agent2.id, entityType: EntityType.SYSTEM}})
            ])
          )
        })

        it("should list mixed entities (users and agents) with correct entityTypes (as OrgAdmin)", async () => {
          // Given: Add user and agent to group
          await prisma.groupMembership.create({
            data: {
              groupId: group.id,
              userId: orgMemberUser.user.id,
              createdAt: new Date(),
              updatedAt: new Date()
            }
          })
          await prisma.agentGroupMembership.create({
            data: {
              groupId: group.id,
              agentId: agent1.id,
              createdAt: new Date(),
              updatedAt: new Date()
            }
          })

          // When
          const response = await get(app, entitiesEndpoint(group.id)).withToken(orgAdminUser.token).build()

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          const body: ListGroupEntities200Response = response.body
          expect(body.entities).toHaveLength(2)
          expect(body.entities).toEqual(
            expect.arrayContaining([
              expect.objectContaining({entity: {entityId: orgMemberUser.user.id, entityType: EntityType.HUMAN}}),
              expect.objectContaining({entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}})
            ])
          )
        })
      })

      describe("bad cases", () => {
        it("should return 401 UNAUTHORIZED if no token is provided", async () => {
          const response = await get(app, entitiesEndpoint(group.id)).build()
          expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
        })

        it("should return 403 FORBIDDEN if agent tries to list group members", async () => {
          // When
          const response = await get(app, entitiesEndpoint(group.id)).withToken(testAgent.token).build()

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
          expect(response.body).toHaveErrorCode("REQUESTOR_NOT_AUTHORIZED")
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
      })
    })

    describe("DELETE", () => {
      describe("good cases", () => {
        it("should remove single agent from the group and return updated group (as OrgAdmin)", async () => {
          // Given: Add agents to group first
          await prisma.agentGroupMembership.createMany({
            data: [
              {
                groupId: group.id,
                agentId: agent1.id,
                createdAt: new Date(),
                updatedAt: new Date()
              },
              {
                groupId: group.id,
                agentId: agent2.id,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            ]
          })

          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}]
          }

          // When
          const response = await del(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          expect(response.body.id).toEqual(group.id)
          expect(response.body.entitiesCount).toEqual(1)

          // Verify DB state
          const remainingMemberships = await prisma.agentGroupMembership.findMany({where: {groupId: group.id}})
          expect(remainingMemberships).toHaveLength(1)
          expect(remainingMemberships[0]?.agentId).toEqual(agent2.id)
        })

        it("should remove multiple agents from the group (as OrgAdmin)", async () => {
          // Given: Add agents to group first
          await prisma.agentGroupMembership.createMany({
            data: [
              {
                groupId: group.id,
                agentId: agent1.id,
                createdAt: new Date(),
                updatedAt: new Date()
              },
              {
                groupId: group.id,
                agentId: agent2.id,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            ]
          })

          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [
              {entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}},
              {entity: {entityId: agent2.id, entityType: EntityType.SYSTEM}}
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
          const remainingMemberships = await prisma.agentGroupMembership.findMany({where: {groupId: group.id}})
          expect(remainingMemberships).toHaveLength(0)
        })
      })

      describe("bad cases", () => {
        it("should return 401 UNAUTHORIZED if no token is provided", async () => {
          const requestBody: RemoveGroupEntitiesRequest = {entities: []}
          const response = await del(app, entitiesEndpoint(group.id)).build().send(requestBody)
          expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
        })

        it("should return 403 FORBIDDEN if agent tries to remove agents", async () => {
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}]
          }
          const response = await del(app, entitiesEndpoint(group.id))
            .withToken(testAgent.token)
            .build()
            .send(requestBody)

          expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
          expect(response.body).toHaveErrorCode("REQUESTOR_NOT_AUTHORIZED")
        })

        it("should return 404 NOT_FOUND (GROUP_NOT_FOUND) if group does not exist (as OrgAdmin)", async () => {
          // Given
          const nonExistentGroupId = randomUUID()
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}]
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

        it("should return 400 BAD_REQUEST (MEMBERSHIP_NOT_FOUND) if agent is not in the group (as OrgAdmin)", async () => {
          // Given: agent1 is not added to group
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}]
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

        it("should return 400 BAD_REQUEST (INVALID_UUID) if groupId is not a UUID (as OrgAdmin)", async () => {
          // Given
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: agent1.id, entityType: EntityType.SYSTEM}}]
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

        it("should return 400 BAD_REQUEST (INVALID_UUID) if agentId is not a UUID in body (as OrgAdmin)", async () => {
          // Given
          const requestBody: RemoveGroupEntitiesRequest = {
            entities: [{entity: {entityId: "not-a-uuid", entityType: EntityType.SYSTEM}}]
          }
          // When
          const response = await del(app, entitiesEndpoint(group.id))
            .withToken(orgAdminUser.token)
            .build()
            .send(requestBody)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("REQUEST_INVALID_ENTITY_UUID")
        })
      })
    })
  })
})
