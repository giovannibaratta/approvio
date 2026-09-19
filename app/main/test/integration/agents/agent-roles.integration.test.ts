import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {PrismaClient} from "@prisma/client"

import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {
  createMockAgentInDb,
  createTestGroup as createTestGroupFixture,
  createMockWorkflowTemplateInDb as createMockWorkflowTemplateFixture,
  MockConfigProvider
} from "@test/mock-data"
import {createAuthenticatedUserInDb, TestTokenBuilder} from "@test/token-helpers"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {get, put, del} from "@test/requests"
import {UserWithToken} from "@test/types"
import "expect-more-jest"
import "@utils/matchers"
import {AGENT_REPOSITORY_TOKEN, AgentRepository} from "@services"
import {wrapTaskEitherWithSideEffect} from "@test/injectors"
import {RoleAssignmentRequest, RoleRemovalRequest} from "@approvio/api"
import {MAX_ROLES_PER_ENTITY} from "@domain"
import {mapAgentToDomain} from "@external/database/shared"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

describe("Agent Roles API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let targetAgent: {id: string; agentName: string; organizationId: string}
  let agentToken: string
  let jwtService: JwtService
  let configProvider: ConfigProvider

  const createTestGroup = (prisma: PrismaClient, overrides?: Parameters<typeof createTestGroupFixture>[1]) =>
    createTestGroupFixture(prisma, {
      ...overrides,
      organizationId: overrides?.organizationId ?? orgAdminUser.user.organizationId
    })
  const createMockWorkflowTemplateInDb = (
    prisma: PrismaClient,
    overrides?: Parameters<typeof createMockWorkflowTemplateFixture>[1]
  ) =>
    createMockWorkflowTemplateFixture(prisma, {
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
    const agent = await createMockAgentInDb(prisma, {
      agentName: "test-agent",
      organizationId: orgAdminUser.user.organizationId
    })
    const domainAgent = unwrapRight(mapAgentToDomain(agent))

    targetAgent = {id: agent.id, agentName: agent.agentName, organizationId: agent.organizationId}
    agentToken = TestTokenBuilder.signAgentToken(jwtService, configProvider, domainAgent)
  })

  const agentRolesEndpoint = (agentId: string): string => `/o/${targetAgent.organizationId}/agents/${agentId}/roles`

  const ifMatchFor = async (agentId: string): Promise<string> => {
    const response = await get(app, `/o/${targetAgent.organizationId}/agents/${agentId}`)
      .withToken(orgAdminUser.token)
      .build()
      .expect(HttpStatus.OK)
    const etag: unknown = response.headers.etag
    if (typeof etag !== "string") throw new Error("Agent GET response is missing its ETag")
    return etag
  }

  afterAll(async () => {})

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

  const createWorkflowTemplateRequest = (roleName: string, templateName: string): RoleAssignmentRequest => ({
    roles: [
      {
        roleName,
        scope: {type: "workflow_template", templateName}
      }
    ]
  })

  const createMultipleWorkflowTemplateRequest = (
    roles: Array<{roleName: string; templateName: string}>
  ): RoleAssignmentRequest => ({
    roles: roles.map(({roleName, templateName}) => ({
      roleName,
      scope: {type: "workflow_template", templateName}
    }))
  })

  const emptyRolesRequest: RoleAssignmentRequest = {
    roles: []
  }

  it("returns the ETag exposed by GET after role assignment", async () => {
    // Given
    const roles = {roles: [{roleName: "OrgWideWorkflowTemplateInstantiator", scope: {type: "org"}}]}
    const endpoint = agentRolesEndpoint(targetAgent.id)
    const previousTag = await ifMatchFor(targetAgent.id)

    // When
    const response = await put(app, endpoint)
      .withToken(orgAdminUser.token)
      .withHeader("If-Match", previousTag)
      .build()
      .send(roles)

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)
    expect(response.headers.etag).toBe(await ifMatchFor(targetAgent.id))
    expect(response.headers.etag).not.toBe(previousTag)
  })

  it("returns the ETag exposed by GET after role removal", async () => {
    // Given
    const roles = {roles: [{roleName: "OrgWideWorkflowTemplateInstantiator", scope: {type: "org"}}]}
    const endpoint = agentRolesEndpoint(targetAgent.id)
    await put(app, endpoint)
      .withToken(orgAdminUser.token)
      .withHeader("If-Match", await ifMatchFor(targetAgent.id))
      .build()
      .send(roles)
      .expect(HttpStatus.NO_CONTENT)
    const previousTag = await ifMatchFor(targetAgent.id)

    // When
    const response = await del(app, endpoint)
      .withToken(orgAdminUser.token)
      .withHeader("If-Match", previousTag)
      .build()
      .send(roles)

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)
    expect(response.headers.etag).toBe(await ifMatchFor(targetAgent.id))
    expect(response.headers.etag).not.toBe(previousTag)
  })

  describe("PUT /agents/{agentId}/roles", () => {
    describe("good cases", () => {
      it("should add organization-wide workflow template role to agent and persist in database", async () => {
        // Given: Valid role assignment request with org scope for workflow template
        const roleAssignmentRequest = createOrgScopeRequest("OrgWideWorkflowTemplateInstantiator")

        // When: Admin assigns workflow template role to agent
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
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
        const roleAssignmentRequest = createWorkflowTemplateRequest("WorkflowTemplateVoter", workflowTemplate.name)

        // When: Admin assigns workflow template role to agent
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
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
            scope: {type: "workflow_template", templateName: workflowTemplate.name},
            permissions: expect.any(Array)
          }
        ])
      })

      it("should add workflow read permissions to agent and persist in database", async () => {
        // Given: Valid role assignment request for workflow read permissions
        const workflowTemplate = await createMockWorkflowTemplateInDb(prisma)
        const roleAssignmentRequest = createWorkflowTemplateRequest("WorkflowReadOnly", workflowTemplate.name)

        // When: Admin assigns workflow read role to agent
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
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
            scope: {type: "workflow_template", templateName: workflowTemplate.name},
            permissions: expect.any(Array)
          }
        ])
      })

      it("should add multiple workflow-related roles to agent and persist in database", async () => {
        // Given: Valid role assignment request with multiple workflow roles
        const workflowTemplate1 = await createMockWorkflowTemplateInDb(prisma)
        const workflowTemplate2 = await createMockWorkflowTemplateInDb(prisma)

        const roleAssignmentRequest = createMultipleWorkflowTemplateRequest([
          {roleName: "WorkflowTemplateInstantiator", templateName: workflowTemplate1.name},
          {roleName: "WorkflowTemplateVoter", templateName: workflowTemplate2.name}
        ])

        // When: Admin assigns multiple workflow roles to agent
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
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
            scope: {type: "workflow_template", templateName: workflowTemplate1.name}
          },
          {
            name: "WorkflowTemplateVoter",
            resourceType: "workflow_template",
            scopeType: "workflow_template",
            scope: {type: "workflow_template", templateName: workflowTemplate2.name}
          }
        ])
      })

      it("should add roles to existing roles without replacing them", async () => {
        // Given: Agent already has a workflow role assigned
        const workflowTemplate1 = await createMockWorkflowTemplateInDb(prisma)
        const workflowTemplate2 = await createMockWorkflowTemplateInDb(prisma)

        // First assignment
        const firstAssignment = createWorkflowTemplateRequest("WorkflowTemplateVoter", workflowTemplate1.name)

        await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(firstAssignment)

        const secondAssignment = createWorkflowTemplateRequest("WorkflowTemplateInstantiator", workflowTemplate2.name)
        // When: Admin adds additional workflow roles

        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
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
            scope: {type: "workflow_template", templateName: workflowTemplate1.name}
          },
          {
            name: "WorkflowTemplateInstantiator",
            scope: {type: "workflow_template", templateName: workflowTemplate2.name}
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
              scope: {type: "workflow_template", templateName: workflowTemplate.name}
            },
            {
              roleName: "WorkflowTemplateVoter",
              scope: {type: "workflow_template", templateName: workflowTemplate.name}
            },
            {
              roleName: "OrgWideWorkflowTemplateInstantiator",
              scope: {type: "org"}
            }
          ]
        }

        // When: Admin assigns workflow roles with duplicates
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
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
            scope: {type: "workflow_template", templateName: workflowTemplate.name}
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
        const response = await put(app, agentRolesEndpoint(targetAgent.id)).build().send(roleAssignmentRequest)

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return BAD REQUEST for invalid token", async () => {
        // Given: Valid role assignment request but invalid token
        const roleAssignmentRequest = createOrgScopeRequest("WorkflowTemplateVoter")

        // When: Making request with invalid token
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
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
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(agentToken)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive forbidden response
        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      })

      it("should return 400 for empty roles array", async () => {
        // Given: Empty roles assignment request
        // When: Admin tries to assign empty roles
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(emptyRolesRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for non-workflow role assignment to agent", async () => {
        // Given: Role assignment request with space role (not allowed for agents)
        const roleAssignmentRequest = createOrgScopeRequest("SpaceManager")

        // When: Admin tries to assign space role to agent
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
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
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for unknown role name", async () => {
        // Given: Role assignment request with invalid role name
        const roleAssignmentRequest = createOrgScopeRequest("UnknownWorkflowRole")

        // When: Admin tries to assign unknown role
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for missing required scope identifier", async () => {
        // Given: Role assignment request missing required templateName
        const roleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template"
                // Missing templateName
              }
            }
          ]
        }

        // When: Admin tries to assign role with invalid scope
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for empty template name in scope", async () => {
        // Given: Role assignment request with empty template name
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                templateName: ""
              }
            }
          ]
        }

        // When: Admin tries to assign role with invalid UUID format
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 404 for an agent deleted after reading its ETag", async () => {
        // Given
        const roleAssignmentRequest = createOrgScopeRequest("OrgWideWorkflowTemplateVoter")
        const etag = await ifMatchFor(targetAgent.id)
        await prisma.agent.delete({where: {id: targetAgent.id}})

        // When: Admin tries to assign role to non-existent agent
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", etag)
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
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(invalidRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for exceeding maximum roles in request (129 roles)", async () => {
        // Given: Role assignment request with more than 128 roles
        const roles = []
        for (let i = 0; i < MAX_ROLES_PER_ENTITY + 1; i++)
          roles.push({
            roleName: "OrgWideWorkflowTemplateVoter",
            scope: {
              type: "org" as const
            }
          })

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles
        }

        // When: Admin tries to assign more than maximum allowed roles in single request
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 422 when total roles would exceed limit", async () => {
        // Given: Agent already has some workflow roles assigned
        // PERFORMANCE OPTIMIZATION: We use space-scoped roles with mock UUIDs instead of template-scoped roles.
        // Since agents only support workflow template resource type roles, space-scoped templates are perfectly valid,
        // but do not execute DB queries checking template existence. This avoids creating 128 templates in the DB.
        const existingRoles = []
        for (let i = 0; i < MAX_ROLES_PER_ENTITY; i++)
          existingRoles.push({
            roleName: "SpaceWideWorkflowTemplateVoter",
            scope: {
              type: "space",
              spaceId: uuidv7()
            }
          })

        // Assign existing roles
        await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: existingRoles
          })

        // When: Admin tries to add more roles that would exceed total limit
        const additionalRoles = []
        for (let i = 0; i < 5; i++)
          additionalRoles.push({
            roleName: "SpaceWideWorkflowTemplateInstantiator",
            scope: {
              type: "space",
              spaceId: uuidv7()
            }
          })

        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: additionalRoles
          })

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.UNPROCESSABLE_ENTITY)
      })
    })

    describe("race conditions", () => {
      let spy: jest.SpiedFunction<AgentRepository["getAgentById"]> | undefined

      afterEach(() => {
        spy?.mockRestore()
      })

      it("should return 409 Conflict if OCC condition fails during role assignment", async () => {
        const agentRepository = app.get<AgentRepository>(AGENT_REPOSITORY_TOKEN)

        // Given: Valid role assignment request
        const roleAssignmentRequest = createOrgScopeRequest("WorkflowTemplateVoter")
        const etag = await ifMatchFor(targetAgent.id)

        // Intercept getAgentById to trigger concurrent modification
        spy = wrapTaskEitherWithSideEffect(agentRepository, "getAgentById", async (_context, agentId) => {
          // Only trigger side effect if fetching the target agent
          if (agentId === targetAgent.id)
            // Manually increment the OCC in the database via raw prisma query
            // This simulates a concurrent update to the agent between read and write
            await prisma.agent.update({
              where: {id: targetAgent.id},
              data: {occ: {increment: 1}}
            })
        })

        // When: Admin assigns role to agent
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", etag)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive a 409 Conflict because of the concurrent update
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body.code).toBe("CONCURRENT_MODIFICATION_ERROR")
      })
    })

    describe("audit logging", () => {
      it("should persist audit log when roles are assigned", async () => {
        // Given: Valid role assignment request
        const roleAssignmentRequest = createOrgScopeRequest("OrgWideWorkflowTemplateInstantiator")

        // When: Admin assigns role to agent
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Audit log should be persisted in database
        const auditLogs = await prisma.auditLog.findMany({
          where: {
            entityId: targetAgent.id,
            auditType: "AGENT_ROLES_ASSIGNED"
          }
        })
        expect(auditLogs).toHaveLength(1)
        expect(auditLogs[0]!.payload).toMatchObject({
          roles: [
            {
              roleName: "OrgWideWorkflowTemplateInstantiator",
              scope: {type: "org"}
            }
          ]
        })
      })

      it("should only log newly assigned roles and ignore already existing ones", async () => {
        // Given: Agent already has a role assigned
        const workflowTemplate1 = await createMockWorkflowTemplateInDb(prisma)
        const workflowTemplate2 = await createMockWorkflowTemplateInDb(prisma)
        await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate1.name}
              }
            ]
          })

        // When: Admin assigns the same role in an existing and a new template scope
        const response = await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate1.name}
              },
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate2.name}
              }
            ]
          })

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Audit log should only contain the newly assigned role
        const auditLogs = await prisma.auditLog.findMany({
          where: {
            entityId: targetAgent.id,
            auditType: "AGENT_ROLES_ASSIGNED"
          },
          orderBy: {createdAt: "desc"}
        })

        // Note: The first PUT created one audit log. The second PUT should only log the new one.
        expect(auditLogs).toHaveLength(2)
        expect(auditLogs[0]!.payload).toMatchObject({
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {type: "workflow_template", templateName: workflowTemplate2.name}
            }
          ]
        })
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
              scope: {type: "workflow_template", templateName: workflowTemplate1.name}
            },
            {
              roleName: "WorkflowTemplateInstantiator",
              scope: {type: "workflow_template", templateName: workflowTemplate2.name}
            }
          ]
        }

        await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(rolePutRequest)

        const delRequest: RoleRemovalRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateInstantiator",
              scope: {type: "workflow_template", templateName: workflowTemplate2.name}
            }
          ]
        }

        // When: Admin removes one role
        const response = await del(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
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
            scope: {type: "workflow_template", templateName: workflowTemplate1.name}
          }
        ])
      })

      it("should remove all roles from agent", async () => {
        // Given: Agent has roles assigned
        const workflowTemplate = await createMockWorkflowTemplateInDb(prisma)
        await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate.name}
              }
            ]
          })

        // When: Admin removes all roles
        const response = await del(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate.name}
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
        await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate1.name}
              }
            ]
          })

        // When: Admin tries to remove a different role
        const response = await del(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate2.name}
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
            scope: {type: "workflow_template", templateName: workflowTemplate1.name}
          }
        ])
      })
    })

    describe("audit logging", () => {
      it("should persist audit log when roles are removed", async () => {
        // Given: Agent has roles assigned
        const workflowTemplate = await createMockWorkflowTemplateInDb(prisma)
        await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate.name}
              }
            ]
          })

        // When: Admin removes role
        const response = await del(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate.name}
              }
            ]
          })

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Audit log should be persisted in database
        const auditLogs = await prisma.auditLog.findMany({
          where: {
            entityId: targetAgent.id,
            auditType: "AGENT_ROLES_REMOVED"
          }
        })
        expect(auditLogs).toHaveLength(1)
        expect(auditLogs[0]!.payload).toMatchObject({
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {type: "workflow_template", templateName: workflowTemplate.name}
            }
          ]
        })
      })

      it("should only log roles that were actually present and removed", async () => {
        // Given: Agent has a role assigned
        const workflowTemplate1 = await createMockWorkflowTemplateInDb(prisma)
        const workflowTemplate2 = await createMockWorkflowTemplateInDb(prisma)
        await put(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate1.name}
              }
            ]
          })

        // When: Admin requests to remove the same role from an existing and an unassigned template scope
        const response = await del(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send({
            roles: [
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate1.name}
              },
              {
                roleName: "WorkflowTemplateVoter",
                scope: {type: "workflow_template", templateName: workflowTemplate2.name}
              }
            ]
          })

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Audit log should only contain the removed role that was actually present
        const auditLogs = await prisma.auditLog.findMany({
          where: {
            entityId: targetAgent.id,
            auditType: "AGENT_ROLES_REMOVED"
          }
        })
        expect(auditLogs).toHaveLength(1)
        expect(auditLogs[0]!.payload).toMatchObject({
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {type: "workflow_template", templateName: workflowTemplate1.name}
            }
          ]
        })
      })
    })

    describe("bad cases", () => {
      it("should return 401 for unauthenticated requests", async () => {
        // Given: Valid role removal request but no auth token
        const roleRemovalRequest: RoleRemovalRequest = createOrgScopeRequest("WorkflowTemplateVoter")

        // When: Making request without token
        const response = await del(app, agentRolesEndpoint(targetAgent.id)).build().send(roleRemovalRequest)

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return BAD REQUEST for invalid token", async () => {
        // Given: Valid role removal request but invalid token
        const roleRemovalRequest: RoleRemovalRequest = createOrgScopeRequest("WorkflowTemplateVoter")

        // When: Making request with invalid token
        const response = await del(app, agentRolesEndpoint(targetAgent.id))
          .withToken("invalid-token")
          .build()
          .send(roleRemovalRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for empty roles array", async () => {
        // Given: Empty roles removal request
        // When: Admin tries to remove empty roles
        const response = await del(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(emptyRolesRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 404 for an agent deleted after reading its ETag", async () => {
        // Given
        const roleRemovalRequest: RoleRemovalRequest = createOrgScopeRequest("OrgWideWorkflowTemplateVoter")
        const etag = await ifMatchFor(targetAgent.id)
        await prisma.agent.delete({where: {id: targetAgent.id}})

        // When: Admin tries to remove role from non-existent agent
        const response = await del(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", etag)
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
        const response = await del(app, agentRolesEndpoint(targetAgent.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetAgent.id))
          .build()
          .send(invalidRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })
    })
  })
})
