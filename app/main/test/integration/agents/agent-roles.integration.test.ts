import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {AGENTS_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient} from "@prisma/client"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "../database"
import {createDomainMockUserInDb, createMockAgentInDb, createTestGroup, MockConfigProvider} from "../shared/mock-data"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {put} from "../shared/requests"
import {UserWithToken} from "../shared/types"
import "expect-more-jest"
import "@utils/matchers"
import {TokenPayloadBuilder} from "@services"
import {RoleAssignmentRequest} from "@approvio/api"
import {MAX_ROLES_PER_ENTITY} from "@domain"

describe("Agent Roles API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let orgAdminUser: UserWithToken
  let targetAgent: {id: string; agentName: string}
  let agentToken: string

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
    const agent = await createMockAgentInDb(prisma, {agentName: "test-agent"})

    const createUserToken = (user: typeof adminUser) => {
      const tokenPayload = TokenPayloadBuilder.from({
        sub: user.id,
        entityType: "user",
        displayName: user.displayName,
        email: user.email,
        issuer: configProvider.jwtConfig.issuer,
        audience: [configProvider.jwtConfig.audience]
      })
      return jwtService.sign(tokenPayload)
    }

    const createAgentToken = (agent: typeof targetAgent) => {
      const tokenPayload = TokenPayloadBuilder.from({
        sub: agent.agentName,
        entityType: "agent",
        displayName: agent.agentName,
        issuer: configProvider.jwtConfig.issuer,
        audience: [configProvider.jwtConfig.audience]
      })
      return jwtService.sign(tokenPayload)
    }

    orgAdminUser = {user: adminUser, token: createUserToken(adminUser)}
    targetAgent = {id: agent.id, agentName: agent.agentName}
    agentToken = createAgentToken(targetAgent)

    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  describe("PUT /agents/{agentId}/roles", () => {
    describe("good cases", () => {
      it("should add organization-wide workflow template role to agent and persist in database", async () => {
        // Given: Valid role assignment request with org scope for workflow template
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "OrgWideWorkflowTemplateInstantiator",
              scope: {
                type: "org"
              }
            }
          ]
        }

        // When: Admin assigns workflow template role to agent
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Role should be persisted in database
        const agentFromDb = await prisma.agent.findUnique({
          where: {id: targetAgent.id}
        })
        expect(agentFromDb).not.toBeNull()
        expect(agentFromDb!.roles).toMatchObject([
          {
            name: "OrgWideWorkflowTemplateInstantiator",
            resourceType: "workflow_template",
            scopeType: "org",
            scope: {type: "org"},
            permissions: expect.any(Array)
          }
        ])
      })

      it("should add workflow template-specific role to agent and persist in database", async () => {
        // Given: Valid role assignment request with workflow template scope
        const workflowTemplateId = randomUUID()

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                workflowTemplateId: workflowTemplateId
              }
            }
          ]
        }

        // When: Admin assigns workflow template role to agent
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Role should be persisted in database
        const agentFromDb = await prisma.agent.findUnique({
          where: {id: targetAgent.id}
        })
        expect(agentFromDb!.roles).toMatchObject([
          {
            name: "WorkflowTemplateVoter",
            resourceType: "workflow_template",
            scopeType: "workflow_template",
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplateId},
            permissions: expect.any(Array)
          }
        ])
      })

      it("should add workflow read permissions to agent and persist in database", async () => {
        // Given: Valid role assignment request for workflow read permissions
        const workflowTemplateId = randomUUID()

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowReadOnly",
              scope: {
                type: "workflow_template",
                workflowTemplateId: workflowTemplateId
              }
            }
          ]
        }

        // When: Admin assigns workflow read role to agent
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Role should be persisted in database
        const agentFromDb = await prisma.agent.findUnique({
          where: {id: targetAgent.id}
        })
        expect(agentFromDb!.roles).toMatchObject([
          {
            name: "WorkflowReadOnly",
            resourceType: "workflow_template",
            scopeType: "workflow_template",
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplateId},
            permissions: expect.any(Array)
          }
        ])
      })

      it("should add multiple workflow-related roles to agent and persist in database", async () => {
        // Given: Valid role assignment request with multiple workflow roles
        const workflowTemplateId1 = randomUUID()
        const workflowTemplateId2 = randomUUID()

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateInstantiator",
              scope: {
                type: "workflow_template",
                workflowTemplateId: workflowTemplateId1
              }
            },
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                workflowTemplateId: workflowTemplateId2
              }
            }
          ]
        }

        // When: Admin assigns multiple workflow roles to agent
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: All roles should be persisted in database
        const agentFromDb = await prisma.agent.findUnique({
          where: {id: targetAgent.id}
        })
        expect(agentFromDb!.roles).toHaveLength(2)
        expect(agentFromDb!.roles).toMatchObject([
          {
            name: "WorkflowTemplateInstantiator",
            resourceType: "workflow_template",
            scopeType: "workflow_template",
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplateId1}
          },
          {
            name: "WorkflowTemplateVoter",
            resourceType: "workflow_template",
            scopeType: "workflow_template",
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplateId2}
          }
        ])
      })

      it("should add roles to existing roles without replacing them", async () => {
        // Given: Agent already has a workflow role assigned
        const workflowTemplateId1 = randomUUID()
        const workflowTemplateId2 = randomUUID()

        // First assignment
        const firstAssignment: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                workflowTemplateId: workflowTemplateId1
              }
            }
          ]
        }

        await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(firstAssignment)

        // When: Admin adds additional workflow roles
        const secondAssignment: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateInstantiator",
              scope: {
                type: "workflow_template",
                workflowTemplateId: workflowTemplateId2
              }
            }
          ]
        }

        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(secondAssignment)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Both roles should exist in database (not replaced)
        const agentFromDb = await prisma.agent.findUnique({
          where: {id: targetAgent.id}
        })
        expect(agentFromDb!.roles).toHaveLength(2)
        expect(agentFromDb!.roles).toMatchObject([
          {
            name: "WorkflowTemplateVoter",
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplateId1}
          },
          {
            name: "WorkflowTemplateInstantiator",
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplateId2}
          }
        ])
      })

      it("should consolidate duplicate workflow roles in request and only add unique ones", async () => {
        // Given: Role assignment request with duplicate workflow roles (should be consolidated)
        const workflowTemplateId = randomUUID()

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                workflowTemplateId: workflowTemplateId
              }
            },
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                workflowTemplateId: workflowTemplateId
              }
            },
            {
              roleName: "OrgWideWorkflowTemplateInstantiator",
              scope: {
                type: "org"
              }
            }
          ]
        }

        // When: Admin assigns workflow roles with duplicates
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Only unique workflow roles should be persisted (duplicates consolidated)
        const agentFromDb = await prisma.agent.findUnique({
          where: {id: targetAgent.id}
        })
        expect(agentFromDb!.roles).toHaveLength(2) // Only 2 unique roles
        expect(agentFromDb!.roles).toMatchObject([
          {
            name: "WorkflowTemplateVoter",
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplateId}
          },
          {
            name: "OrgWideWorkflowTemplateInstantiator",
            scope: {type: "org"}
          }
        ])
      })
    })

    describe("bad cases", () => {
      it("should return 401 for unauthenticated requests", async () => {
        // Given: Valid role assignment request but no auth token
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "org"
              }
            }
          ]
        }

        // When: Making request without token
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 401 for invalid token", async () => {
        // Given: Valid role assignment request but invalid token
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "org"
              }
            }
          ]
        }

        // When: Making request with invalid token
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken("invalid-token")
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 403 when agent tries to assign roles", async () => {
        // Given: Valid role assignment request but agent token (not human)
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "org"
              }
            }
          ]
        }

        // When: Agent tries to assign roles (forbidden - only humans allowed)
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(agentToken)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive forbidden response
        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      })

      it("should return 400 for empty roles array", async () => {
        // Given: Empty roles assignment request
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: []
        }

        // When: Admin tries to assign empty roles
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for non-workflow role assignment to agent", async () => {
        // Given: Role assignment request with space role (not allowed for agents)
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "SpaceManager",
              scope: {
                type: "org"
              }
            }
          ]
        }

        // When: Admin tries to assign space role to agent
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for group role assignment to agent", async () => {
        // Given: Role assignment request with group role (not allowed for agents)
        const group = await createTestGroup(prisma, {name: "Test Group"})

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "GroupManager",
              scope: {
                type: "group",
                groupId: group.id
              }
            }
          ]
        }

        // When: Admin tries to assign group role to agent
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for unknown role name", async () => {
        // Given: Role assignment request with invalid role name
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "UnknownWorkflowRole",
              scope: {
                type: "org"
              }
            }
          ]
        }

        // When: Admin tries to assign unknown role
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for missing required scope identifier", async () => {
        // Given: Role assignment request missing required workflowTemplateId
        const roleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template"
                // Missing workflowTemplateId
              }
            }
          ]
        }

        // When: Admin tries to assign role with invalid scope
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for invalid UUID format in scope", async () => {
        // Given: Role assignment request with invalid UUID format
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                workflowTemplateId: "invalid-uuid"
              }
            }
          ]
        }

        // When: Admin tries to assign role with invalid UUID format
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 404 for non-existent agent", async () => {
        // Given: Valid role assignment request but non-existent agent ID
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "OrgWideWorkflowTemplateVoter",
              scope: {
                type: "org"
              }
            }
          ]
        }

        const nonExistentAgentId = randomUUID()

        // When: Admin tries to assign role to non-existent agent
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${nonExistentAgentId}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive not found response
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
      })

      it("should return 400 for invalid request body structure", async () => {
        // Given: Invalid request body structure
        const invalidRequest = {
          invalidField: "value"
        }

        // When: Admin sends invalid request body
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(invalidRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for exceeding maximum roles in request (129 roles)", async () => {
        // Given: Role assignment request with more than 128 roles
        const roles = []
        for (let i = 0; i < MAX_ROLES_PER_ENTITY + 1; i++) {
          roles.push({
            roleName: "OrgWideWorkflowTemplateVoter",
            scope: {
              type: "org" as const
            }
          })
        }

        const roleAssignmentRequest: RoleAssignmentRequest = {roles}

        // When: Admin tries to assign more than maximum allowed roles in single request
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 422 when total roles would exceed limit", async () => {
        // Given: Agent already has some workflow roles assigned
        const existingRoles = []
        for (let i = 0; i < MAX_ROLES_PER_ENTITY; i++) {
          const workflowTemplateId = randomUUID()
          existingRoles.push({
            roleName: "WorkflowTemplateVoter",
            scope: {
              type: "workflow_template",
              workflowTemplateId: workflowTemplateId
            }
          })
        }

        // Assign existing roles
        await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({roles: existingRoles})

        // When: Admin tries to add more roles that would exceed total limit
        const additionalRoles = []
        for (let i = 0; i < 5; i++) {
          const workflowTemplateId = randomUUID()
          additionalRoles.push({
            roleName: "WorkflowTemplateInstantiator",
            scope: {
              type: "workflow_template",
              workflowTemplateId: workflowTemplateId
            }
          })
        }

        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({roles: additionalRoles})

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.UNPROCESSABLE_ENTITY)
      })
    })
  })
})
