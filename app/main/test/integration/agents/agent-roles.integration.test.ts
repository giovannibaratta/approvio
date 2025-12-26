import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {AGENTS_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient} from "@prisma/client"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {
  createDomainMockUserInDb,
  createMockAgentInDb,
  createTestGroup,
  createMockWorkflowTemplateInDb,
  createMockSpaceInDb,
  MockConfigProvider
} from "@test/mock-data"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {put, del} from "@test/requests"
import {UserWithToken} from "@test/types"
import "expect-more-jest"
import "@utils/matchers"
import {TokenPayloadBuilder} from "@services"
import {RoleAssignmentRequest, RoleRemovalRequest} from "@approvio/api"
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

  const createOrgScopeRequest = (roleName: string): RoleAssignmentRequest => ({
    roles: [
      {
        roleName,
        scope: {type: "org"}
      }
    ]
  })

  const createWorkflowTemplateRequest = (roleName: string, workflowTemplateId: string): RoleAssignmentRequest => ({
    roles: [
      {
        roleName,
        scope: {type: "workflow_template", workflowTemplateId}
      }
    ]
  })

  const createMultipleWorkflowTemplateRequest = (
    roles: Array<{roleName: string; workflowTemplateId: string}>
  ): RoleAssignmentRequest => ({
    roles: roles.map(({roleName, workflowTemplateId}) => ({
      roleName,
      scope: {type: "workflow_template", workflowTemplateId}
    }))
  })

  const emptyRolesRequest: RoleAssignmentRequest = {roles: []}

  describe("PUT /agents/{agentId}/roles", () => {
    describe("good cases", () => {
      it("should add organization-wide workflow template role to agent and persist in database", async () => {
        // Given: Valid role assignment request with org scope for workflow template
        const roleAssignmentRequest = createOrgScopeRequest("OrgWideWorkflowTemplateInstantiator")

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
        const workflowTemplate = await createMockWorkflowTemplateInDb(prisma)
        const roleAssignmentRequest = createWorkflowTemplateRequest("WorkflowTemplateVoter", workflowTemplate.id)

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
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplate.id},
            permissions: expect.any(Array)
          }
        ])
      })

      it("should add workflow read permissions to agent and persist in database", async () => {
        // Given: Valid role assignment request for workflow read permissions
        const workflowTemplate = await createMockWorkflowTemplateInDb(prisma)
        const roleAssignmentRequest = createWorkflowTemplateRequest("WorkflowReadOnly", workflowTemplate.id)

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
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplate.id},
            permissions: expect.any(Array)
          }
        ])
      })

      it("should add multiple workflow-related roles to agent and persist in database", async () => {
        // Given: Valid role assignment request with multiple workflow roles
        const workflowTemplate1 = await createMockWorkflowTemplateInDb(prisma)
        const workflowTemplate2 = await createMockWorkflowTemplateInDb(prisma)

        const roleAssignmentRequest = createMultipleWorkflowTemplateRequest([
          {roleName: "WorkflowTemplateInstantiator", workflowTemplateId: workflowTemplate1.id},
          {roleName: "WorkflowTemplateVoter", workflowTemplateId: workflowTemplate2.id}
        ])

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
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplate1.id}
          },
          {
            name: "WorkflowTemplateVoter",
            resourceType: "workflow_template",
            scopeType: "workflow_template",
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplate2.id}
          }
        ])
      })

      it("should add roles to existing roles without replacing them", async () => {
        // Given: Agent already has a workflow role assigned
        const workflowTemplate1 = await createMockWorkflowTemplateInDb(prisma)
        const workflowTemplate2 = await createMockWorkflowTemplateInDb(prisma)

        // First assignment
        const firstAssignment = createWorkflowTemplateRequest("WorkflowTemplateVoter", workflowTemplate1.id)

        await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(firstAssignment)

        // When: Admin adds additional workflow roles
        const secondAssignment = createWorkflowTemplateRequest("WorkflowTemplateInstantiator", workflowTemplate2.id)

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
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplate1.id}
          },
          {
            name: "WorkflowTemplateInstantiator",
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplate2.id}
          }
        ])
      })

      it("should consolidate duplicate workflow roles in request and only add unique ones", async () => {
        // Given: Role assignment request with duplicate workflow roles (should be consolidated)
        const workflowTemplate = await createMockWorkflowTemplateInDb(prisma)

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {type: "workflow_template", workflowTemplateId: workflowTemplate.id}
            },
            {
              roleName: "WorkflowTemplateVoter",
              scope: {type: "workflow_template", workflowTemplateId: workflowTemplate.id}
            },
            {
              roleName: "OrgWideWorkflowTemplateInstantiator",
              scope: {type: "org"}
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
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplate.id}
          },
          {
            name: "OrgWideWorkflowTemplateInstantiator",
            scope: {type: "org"}
          }
        ])
      })
    })

    describe("bad cases", () => {
      it("should return UNAUTHORIZED for unauthenticated requests", async () => {
        // Given: Valid role assignment request but no auth token
        const roleAssignmentRequest = createOrgScopeRequest("WorkflowTemplateVoter")

        // When: Making request without token
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return BAD REQUEST for invalid token", async () => {
        // Given: Valid role assignment request but invalid token
        const roleAssignmentRequest = createOrgScopeRequest("WorkflowTemplateVoter")

        // When: Making request with invalid token
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken("invalid-token")
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 403 when agent tries to assign roles", async () => {
        // Given: Valid role assignment request but agent token (not human)
        const roleAssignmentRequest = createOrgScopeRequest("WorkflowTemplateVoter")

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
        // When: Admin tries to assign empty roles
        const response = await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(emptyRolesRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for non-workflow role assignment to agent", async () => {
        // Given: Role assignment request with space role (not allowed for agents)
        const roleAssignmentRequest = createOrgScopeRequest("SpaceManager")

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
              scope: {type: "group", groupId: group.id}
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
        const roleAssignmentRequest = createOrgScopeRequest("UnknownWorkflowRole")

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
        const roleAssignmentRequest = createOrgScopeRequest("OrgWideWorkflowTemplateVoter")

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
        // Create a single space for all templates to avoid parallel creation issues
        const space = await createMockSpaceInDb(prisma)
        const templates = await Promise.all(
          Array.from({length: MAX_ROLES_PER_ENTITY}, () => createMockWorkflowTemplateInDb(prisma, {spaceId: space.id}))
        )
        for (const template of templates) {
          existingRoles.push({
            roleName: "WorkflowTemplateVoter",
            scope: {
              type: "workflow_template",
              workflowTemplateId: template.id
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
        const additionalTemplates = await Promise.all(
          Array.from({length: 5}, () => createMockWorkflowTemplateInDb(prisma, {spaceId: space.id}))
        )
        for (const template of additionalTemplates) {
          additionalRoles.push({
            roleName: "WorkflowTemplateInstantiator",
            scope: {
              type: "workflow_template",
              workflowTemplateId: template.id
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

  describe("DELETE /agents/{agentId}/roles", () => {
    describe("good cases", () => {
      it("should remove single role from agent", async () => {
        // Given: Agent has roles assigned
        const workflowTemplate1 = await createMockWorkflowTemplateInDb(prisma)
        const workflowTemplate2 = await createMockWorkflowTemplateInDb(prisma)

        const rolePutRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {type: "workflow_template", workflowTemplateId: workflowTemplate1.id}
            },
            {
              roleName: "WorkflowTemplateInstantiator",
              scope: {type: "workflow_template", workflowTemplateId: workflowTemplate2.id}
            }
          ]
        }

        await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(rolePutRequest)

        const delRequest: RoleRemovalRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateInstantiator",
              scope: {type: "workflow_template", workflowTemplateId: workflowTemplate2.id}
            }
          ]
        }

        // When: Admin removes one role
        const response = await del(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(delRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Only the other role should remain
        const agentFromDb = await prisma.agent.findUnique({
          where: {id: targetAgent.id}
        })
        expect(agentFromDb!.roles).toHaveLength(1)
        expect(agentFromDb!.roles).toMatchObject([
          {
            name: "WorkflowTemplateVoter",
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplate1.id}
          }
        ])
      })

      it("should remove all roles from agent", async () => {
        // Given: Agent has roles assigned
        const workflowTemplate = await createMockWorkflowTemplateInDb(prisma)
        await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", workflowTemplateId: workflowTemplate.id}
              }
            ]
          })

        // When: Admin removes all roles
        const response = await del(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", workflowTemplateId: workflowTemplate.id}
              }
            ]
          })

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Agent should have no roles
        const agentFromDb = await prisma.agent.findUnique({
          where: {id: targetAgent.id}
        })
        expect(agentFromDb!.roles).toHaveLength(0)
      })

      it("should handle removing non-existent role gracefully (no-op)", async () => {
        // Given: Agent has one role assigned
        const workflowTemplate1 = await createMockWorkflowTemplateInDb(prisma)
        const workflowTemplate2 = await createMockWorkflowTemplateInDb(prisma)
        await put(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", workflowTemplateId: workflowTemplate1.id}
              }
            ]
          })

        // When: Admin tries to remove a different role
        const response = await del(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateInstantiator",
                scope: {type: "workflow_template", workflowTemplateId: workflowTemplate2.id}
              }
            ]
          })

        // Then: Should receive success response (no-op)
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Original role should still exist
        const agentFromDb = await prisma.agent.findUnique({
          where: {id: targetAgent.id}
        })
        expect(agentFromDb!.roles).toHaveLength(1)
        expect(agentFromDb!.roles).toMatchObject([
          {
            name: "WorkflowTemplateVoter",
            scope: {type: "workflow_template", workflowTemplateId: workflowTemplate1.id}
          }
        ])
      })
    })

    describe("bad cases", () => {
      it("should return 401 for unauthenticated requests", async () => {
        // Given: Valid role removal request but no auth token
        const roleRemovalRequest: RoleRemovalRequest = createOrgScopeRequest("WorkflowTemplateVoter")

        // When: Making request without token
        const response = await del(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .build()
          .send(roleRemovalRequest)

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return BAD REQUEST for invalid token", async () => {
        // Given: Valid role removal request but invalid token
        const roleRemovalRequest: RoleRemovalRequest = createOrgScopeRequest("WorkflowTemplateVoter")

        // When: Making request with invalid token
        const response = await del(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken("invalid-token")
          .build()
          .send(roleRemovalRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for empty roles array", async () => {
        // Given: Empty roles removal request
        // When: Admin tries to remove empty roles
        const response = await del(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(emptyRolesRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 404 for non-existent agent", async () => {
        // Given: Valid role removal request but non-existent agent ID
        const roleRemovalRequest: RoleRemovalRequest = createOrgScopeRequest("OrgWideWorkflowTemplateVoter")

        const nonExistentAgentId = randomUUID()

        // When: Admin tries to remove role from non-existent agent
        const response = await del(app, `/${AGENTS_ENDPOINT_ROOT}/${nonExistentAgentId}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleRemovalRequest)

        // Then: Should receive not found response
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
      })

      it("should return 400 for invalid request body structure", async () => {
        // Given: Invalid request body structure
        const invalidRequest = {
          invalidField: "value"
        }

        // When: Admin sends invalid request body
        const response = await del(app, `/${AGENTS_ENDPOINT_ROOT}/${targetAgent.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(invalidRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })
    })
  })
})
