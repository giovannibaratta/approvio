import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {PrismaClient} from "@prisma/client"

import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {
  createTestGroup as createTestGroupFixture,
  createMockSpaceInDb as createMockSpaceFixture,
  createMockWorkflowTemplateInDb as createMockWorkflowTemplateFixture,
  MockConfigProvider
} from "@test/mock-data"
import {createAuthenticatedUserInDb as createAuthenticatedUserFixture} from "@test/token-helpers"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {put, del} from "@test/requests"
import {UserWithToken} from "@test/types"
import "expect-more-jest"
import "@utils/matchers"
import {USER_REPOSITORY_TOKEN, UserRepository, AUDIT_LOG_REPOSITORY_TOKEN, AuditLogRepository} from "@services"
import {createEntityTag} from "@controllers"
import {RoleAssignmentRequest} from "@approvio/api"
import {MAX_ROLES_PER_ENTITY} from "@domain"
import {wrapTaskEitherWithSideEffect, failTaskEither} from "@test/injectors"
import {v7 as uuidv7} from "uuid"

describe("User Roles API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let orgAdminUser: UserWithToken
  let targetUser: UserWithToken
  let organizationId: ReturnType<typeof toOrganizationId>

  const createTestGroup = (prisma: PrismaClient, overrides?: Parameters<typeof createTestGroupFixture>[1]) =>
    createTestGroupFixture(prisma, {...overrides, organizationId: overrides?.organizationId ?? organizationId})
  const createMockSpaceInDb = (prisma: PrismaClient, overrides?: Parameters<typeof createMockSpaceFixture>[1]) =>
    createMockSpaceFixture(prisma, {...overrides, organizationId: overrides?.organizationId ?? organizationId})
  const createMockWorkflowTemplateInDb = (
    prisma: PrismaClient,
    overrides?: Parameters<typeof createMockWorkflowTemplateFixture>[1]
  ) =>
    createMockWorkflowTemplateFixture(prisma, {
      ...overrides,
      organizationId: overrides?.organizationId ?? organizationId
    })
  const createAuthenticatedUserInDb = (
    prisma: PrismaClient,
    jwtService: JwtService,
    configProvider: ConfigProvider,
    overrides?: Parameters<typeof createAuthenticatedUserFixture>[3]
  ) =>
    createAuthenticatedUserFixture(prisma, jwtService, configProvider, {
      ...overrides,
      organizationId: overrides?.organizationId ?? organizationId
    })

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb))
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
    organizationId = randomOrgId()
    orgAdminUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})
    targetUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: false})
  })

  afterAll(async () => {})

  afterEach(async () => {
    await cleanDatabase(prisma)
    jest.restoreAllMocks()
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

  const createSpaceRequest = (
    roleName: string,
    spaceId: string,
    _occVersion = "-9223372036854775808"
  ): RoleAssignmentRequest => ({
    roles: [
      {
        roleName,
        scope: {type: "space", spaceId}
      }
    ]
  })

  const createGroupRequest = (
    roleName: string,
    groupId: string,
    _occVersion = "-9223372036854775808"
  ): RoleAssignmentRequest => ({
    roles: [
      {
        roleName,
        scope: {type: "group", groupId}
      }
    ]
  })

  const createWorkflowTemplateRequest = (
    roleName: string,
    templateName: string,
    _occVersion = "-9223372036854775808"
  ): RoleAssignmentRequest => ({
    roles: [
      {
        roleName,
        scope: {type: "workflow_template", templateName}
      }
    ]
  })

  const ifMatchFor = async (userId: string, version?: bigint): Promise<string> => {
    const currentUser =
      version === undefined
        ? await prisma.user.findUniqueOrThrow({
            where: {organizationId_id: {organizationId: targetUser.user.organizationId, id: userId}}
          })
        : {organizationId: targetUser.user.organizationId, occ: version}

    return createEntityTag(configProvider.jwtConfig.secret, currentUser.organizationId, userId, currentUser.occ)
  }

  const userRolesEndpoint = (userId: string): string => `/o/${targetUser.user.organizationId}/users/${userId}/roles`

  it.each(["assignment", "removal"])("returns the persisted ETag after role %s", async action => {
    const roles = {roles: [{roleName: "OrgWideSpaceManager", scope: {type: "org"}}]}
    const endpoint = userRolesEndpoint(targetUser.user.id)
    if (action === "removal")
      await put(app, endpoint)
        .withToken(orgAdminUser.token)
        .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
        .build()
        .send(roles)
        .expect(HttpStatus.NO_CONTENT)

    const previousTag = await ifMatchFor(targetUser.user.id)
    const response = await (action === "assignment" ? put(app, endpoint) : del(app, endpoint))
      .withToken(orgAdminUser.token)
      .withHeader("If-Match", previousTag)
      .build()
      .send(roles)

    expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)
    expect(response.headers.etag).toBe(await ifMatchFor(targetUser.user.id))
    expect(response.headers.etag).not.toBe(previousTag)
  })

  describe("PUT /users/{userId}/roles", () => {
    describe("good cases", () => {
      it("should add organization-wide role to user and persist in database", async () => {
        // Given: Valid role assignment request with org scope
        const roleAssignmentRequest = createOrgScopeRequest("OrgWideSpaceManager")

        // When: Admin assigns role to user
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Role should be persisted in database
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb).not.toBeNull()
        expect(userFromDb!.roles).toMatchObject([
          {
            name: "OrgWideSpaceManager",
            scope: {type: "org"}
          }
        ])
      })

      it("should add space-specific role to user and persist in database", async () => {
        // Given: Valid role assignment request with space scope
        const spaceId = uuidv7()
        const roleAssignmentRequest = createSpaceRequest("SpaceManager", spaceId)

        // When: Admin assigns space role to user
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Role should be persisted in database
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toMatchObject([
          {
            name: "SpaceManager",
            scope: {type: "space", spaceId: spaceId}
          }
        ])
      })

      it("should add group-specific role to user and persist in database", async () => {
        // Given: A group exists and valid role assignment request
        const group = await createTestGroup(prisma, {
          name: "Test Group",
          description: "Test group for role assignment"
        })

        const roleAssignmentRequest = createGroupRequest("GroupManager", group.id)

        // When: Admin assigns group role to user
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Role should be persisted in database
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toMatchObject([
          {
            name: "GroupManager",
            scope: {type: "group", groupId: group.id}
          }
        ])
      })

      it("should add multiple roles to user and persist in database", async () => {
        // Given: Valid role assignment request with multiple roles
        const group = await createTestGroup(prisma, {name: "Existing Role Scope"})

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {roleName: "OrgWideSpaceReadOnly", scope: {type: "org"}},
            {roleName: "GroupReadOnly", scope: {type: "group", groupId: group.id}}
          ]
        }

        // When: Admin assigns multiple roles to user
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: All roles should be persisted in database
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toHaveLength(2)
        expect(userFromDb!.roles).toMatchObject([
          {
            name: "OrgWideSpaceReadOnly",
            scope: {type: "org"}
          },
          {
            name: "GroupReadOnly",
            scope: {type: "group", groupId: group.id}
          }
        ])
      })

      it("should add roles to existing roles without replacing them", async () => {
        // Given: User already has a role assigned
        const group1 = await createTestGroup(prisma, {name: "Group 1"})
        const group2 = await createTestGroup(prisma, {name: "Group 2"})

        // First assignment
        const firstAssignment = createGroupRequest("GroupReadOnly", group1.id)

        await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(firstAssignment)

        // When: Admin adds additional roles
        const secondAssignment = createGroupRequest("GroupManager", group2.id)

        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(secondAssignment)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Both roles should exist in database (not replaced)
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toHaveLength(2)
        expect(userFromDb!.roles).toMatchObject([
          {
            name: "GroupReadOnly",
            scope: {type: "group", groupId: group1.id}
          },
          {
            name: "GroupManager",
            scope: {type: "group", groupId: group2.id}
          }
        ])
      })

      it("should return 400 when assigning workflow template role with non-existent resource ID", async () => {
        // Given: Role assignment request with non-existent workflow template ID
        const nonExistentWorkflowTemplateId = uuidv7()
        const roleAssignmentRequest = createWorkflowTemplateRequest(
          "WorkflowTemplateReadOnly",
          nonExistentWorkflowTemplateId
        )

        // When: Admin assigns role with non-existent resource ID
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should handle maximum of 128 unique roles assignment with different scopes", async () => {
        // Given: Role assignment request with 128 unique roles (maximum allowed)
        // PERFORMANCE OPTIMIZATION: We use mock group UUIDs directly instead of creating groups in the DB
        // to avoid 127 sequential DB insertions.
        const roles = []
        // Add 127 group-specific roles
        for (let i = 0; i < 127; i++)
          roles.push({
            roleName: "GroupReadOnly",
            scope: {
              type: "group" as const,
              groupId: uuidv7()
            }
          })

        // Add 1 org-wide role
        roles.push({
          roleName: "OrgWideSpaceReadOnly",
          scope: {
            type: "org" as const
          }
        })

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles
        }

        // When: Admin assigns maximum number of unique roles
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: All roles should be persisted in database
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toHaveLength(128)
      })

      it("should consolidate duplicate roles in request and only add unique ones", async () => {
        // Given: Role assignment request with duplicate roles (should be consolidated)
        const group = await createTestGroup(prisma, {name: "Test Group"})

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {roleName: "GroupReadOnly", scope: {type: "group", groupId: group.id}},
            {roleName: "GroupReadOnly", scope: {type: "group", groupId: group.id}},
            {roleName: "OrgWideSpaceReadOnly", scope: {type: "org"}}
          ]
        }

        // When: Admin assigns roles with duplicates
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Only unique roles should be persisted (duplicates consolidated)
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toHaveLength(2) // Only 2 unique roles
        expect(userFromDb!.roles).toMatchObject([
          {
            name: "GroupReadOnly",
            scope: {type: "group", groupId: group.id}
          },
          {
            name: "OrgWideSpaceReadOnly",
            scope: {type: "org"}
          }
        ])
      })
    })

    describe("race conditions", () => {
      let spy: jest.SpiedFunction<UserRepository["getUserById"]> | undefined

      afterEach(() => {
        spy?.mockRestore()
      })

      it("should return 409 Conflict if OCC condition fails during role assignment", async () => {
        const userRepository = app.get<UserRepository>(USER_REPOSITORY_TOKEN)

        // Given: Valid role assignment request
        const roleAssignmentRequest = createOrgScopeRequest("OrgWideSpaceManager")

        // Intercept getUserById to trigger concurrent modification
        spy = wrapTaskEitherWithSideEffect(userRepository, "getUserById", async (_context, userId) => {
          // Only trigger side effect if fetching the target user (prevent intercepting jwt validation)
          if (userId === targetUser.user.id)
            // Manually increment the OCC in the database via raw prisma query
            // This simulates a concurrent update to the user between read and write
            await prisma.user.update({
              where: {
                organizationId_id: {organizationId: targetUser.user.organizationId, id: targetUser.user.id}
              },
              data: {occ: {increment: 1}}
            })
        })

        // When: Admin assigns role to user
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive a 409 Conflict because of the concurrent update
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body.code).toBe("CONCURRENT_MODIFICATION_ERROR")
      })
    })

    describe("bad cases", () => {
      it("should return 401 for unauthenticated requests", async () => {
        // Given: Valid role assignment request but no auth token
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "GroupReadOnly",
              scope: {
                type: "org"
              }
            }
          ]
        }

        // When: Making request without token
        const response = await put(app, userRolesEndpoint(targetUser.user.id)).build().send(roleAssignmentRequest)

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return BAD REQUEST with invalid authentication token", async () => {
        // Given: Valid role assignment request but invalid token
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "GroupReadOnly",
              scope: {
                type: "org"
              }
            }
          ]
        }

        const authToken = "invalid-token"

        // When: Making request with invalid token
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(authToken)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for empty roles array", async () => {
        // Given: Empty roles assignment request
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: []
        }

        // When: Admin tries to assign empty roles
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
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
              roleName: "UnknownRole",
              scope: {
                type: "org"
              }
            }
          ]
        }

        // When: Admin tries to assign unknown role
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for missing required scope identifier", async () => {
        // Given: Role assignment request missing required spaceId
        const roleAssignmentRequest = {
          roles: [
            {
              roleName: "SpaceManager",
              scope: {
                type: "space"
                // Missing spaceId - this is intentionally invalid for testing
              }
            }
          ]
        }

        // When: Admin tries to assign role with invalid scope
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
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
              roleName: "GroupManager",
              scope: {
                type: "group",
                groupId: "invalid-uuid"
              }
            }
          ]
        }

        // When: Admin tries to assign role with invalid UUID format
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 404 for non-existent user", async () => {
        // Given: Valid role assignment request but non-existent user ID
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "OrgWideSpaceReadOnly",
              scope: {
                type: "org"
              }
            }
          ]
        }

        const nonExistentUserId = uuidv7()

        // When: Admin tries to assign role to non-existent user
        const response = await put(app, userRolesEndpoint(nonExistentUserId))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(nonExistentUserId, 0n))
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
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(invalidRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for role with incorrect scope type", async () => {
        // Given: Role assignment request with incompatible scope
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "GroupReadOnly", // Group role
              scope: {
                type: "org" // But org scope
              }
            }
          ]
        }

        // When: Admin tries to assign role with incompatible scope
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for exceeding maximum roles in request (129 roles)", async () => {
        // Given: Role assignment request with more than 128 roles
        const roles = []
        for (let i = 0; i < MAX_ROLES_PER_ENTITY + 1; i++)
          roles.push({
            roleName: "OrgWideSpaceReadOnly",
            scope: {
              type: "org" as const
            }
          })

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles
        }

        // When: Admin tries to assign more than maximum allowed roles in single request
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 422 when total roles would exceed limit", async () => {
        // Given: User already has some roles assigned
        // PERFORMANCE OPTIMIZATION: We use mock group UUIDs directly instead of creating groups in the DB.
        // Role assignment validations check role schemas and permission configurations, but do not query
        // group database existence. This avoids 128 sequential DB insertions.
        const existingRoles = []
        for (let i = 0; i < MAX_ROLES_PER_ENTITY; i++)
          existingRoles.push({
            roleName: "GroupReadOnly",
            scope: {
              type: "group",
              groupId: uuidv7()
            }
          })

        // Assign existing roles
        await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: existingRoles
          })

        // When: Admin tries to add more roles that would exceed total limit
        const additionalRoles = []
        for (let i = 0; i < 5; i++)
          additionalRoles.push({
            roleName: "GroupManager",
            scope: {
              type: "group",
              groupId: uuidv7()
            }
          })

        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: additionalRoles
          })

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.UNPROCESSABLE_ENTITY)
      })
    })

    describe("audit logging", () => {
      it("should persist audit log when roles are assigned", async () => {
        // Given: Valid role assignment request
        const roleAssignmentRequest = createOrgScopeRequest("OrgWideSpaceManager")

        // When: Admin assigns role to user
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Audit log should be persisted in database
        const auditLogs = await prisma.auditLog.findMany({
          where: {
            entityId: targetUser.user.id,
            auditType: "USER_ROLES_ASSIGNED"
          }
        })
        expect(auditLogs).toHaveLength(1)
        expect(auditLogs[0]!.payload).toMatchObject({
          roles: [
            {
              roleName: "OrgWideSpaceManager",
              scope: {type: "org"}
            }
          ]
        })
      })

      it("should return 500 UNKNOWN_ERROR and not update roles if audit log creation fails", async () => {
        const auditLogRepo = app.get<AuditLogRepository>(AUDIT_LOG_REPOSITORY_TOKEN)

        // Given: Audit log persistence will fail
        failTaskEither(auditLogRepo, "persist", "unknown_error")

        // And: Valid role assignment request
        const roleAssignmentRequest = createOrgScopeRequest("OrgWideSpaceManager")

        // When: Admin assigns role to user
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive 500 Unknown Error
        expect(response).toHaveStatusCode(HttpStatus.INTERNAL_SERVER_ERROR)

        // And: Roles should NOT be updated in database (transaction rollback)
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toHaveLength(0)
      })

      it("should only log newly assigned roles and ignore already existing ones", async () => {
        // Given: User already has "GroupReadOnly" role
        const group = await createTestGroup(prisma, {name: "Test Group"})
        await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "GroupReadOnly",
                scope: {type: "group", groupId: group.id}
              }
            ]
          })

        const otherGroup = await createTestGroup(prisma, {name: "New Role Scope"})

        // When: Admin assigns the same role in an existing and a new group scope
        const response = await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "GroupReadOnly",
                scope: {type: "group", groupId: group.id}
              },
              {
                roleName: "GroupReadOnly",
                scope: {type: "group", groupId: otherGroup.id}
              }
            ]
          })

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Audit log should only contain the newly assigned role
        const auditLogs = await prisma.auditLog.findMany({
          where: {
            entityId: targetUser.user.id,
            auditType: "USER_ROLES_ASSIGNED"
          },
          orderBy: {createdAt: "desc"}
        })

        // The second PUT should log only the new group scope.
        expect(auditLogs).toHaveLength(2)
        expect(auditLogs[0]!.payload).toMatchObject({
          roles: [
            {
              roleName: "GroupReadOnly",
              scope: {type: "group", groupId: otherGroup.id}
            }
          ]
        })
      })
    })

    describe("workflow template role authorization", () => {
      let spaceId: string
      let otherSpaceId: string
      let templateName: string
      let workflowTemplateInOtherSpace: string
      let spaceManagerUser: UserWithToken
      let regularUser: UserWithToken

      beforeEach(async () => {
        // Given: Create spaces and workflow templates
        const space = await createMockSpaceInDb(prisma, {name: "Main Space"})
        const otherSpace = await createMockSpaceInDb(prisma, {name: "Other Space"})
        spaceId = space.id
        otherSpaceId = otherSpace.id

        const template = await createMockWorkflowTemplateInDb(prisma, {
          name: "Template in Main Space",
          spaceId: spaceId
        })
        const templateInOther = await createMockWorkflowTemplateInDb(prisma, {
          name: "Template in Other Space",
          spaceId: otherSpaceId
        })
        templateName = template.name
        workflowTemplateInOtherSpace = templateInOther.name

        // Given: Create users
        spaceManagerUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
          orgAdmin: false,
          roles: [
            {
              name: "SpaceManager",
              resourceType: "space",
              permissions: ["read", "manage"],
              scopeType: "space",
              scope: {type: "space", organizationId: targetUser.user.organizationId, spaceId: spaceId}
            }
          ]
        })
        regularUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: false})
      })

      it("should allow org admin to assign workflow template role", async () => {
        // Given: Org admin wants to assign workflow template role
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                templateName: templateName
              }
            }
          ]
        }

        // When: Org admin assigns workflow template role
        const response = await put(app, userRolesEndpoint(regularUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(regularUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Expect: Should succeed
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Role should be persisted
        const userFromDb = await prisma.user.findUnique({
          where: {id: regularUser.user.id}
        })
        expect(userFromDb!.roles).toMatchObject([
          {
            name: "WorkflowTemplateVoter",
            scope: {type: "workflow_template", templateName: templateName}
          }
        ])
      })

      it("should allow space manager to assign workflow template role for template in their space", async () => {
        // Given: Space manager wants to assign workflow template role for template in their managed space
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                templateName: templateName
              }
            }
          ]
        }

        // When: Space manager assigns workflow template role for template in their space
        const response = await put(app, userRolesEndpoint(regularUser.user.id))
          .withToken(spaceManagerUser.token)
          .withHeader("If-Match", await ifMatchFor(regularUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Expect: Should succeed
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Role should be persisted
        const userFromDb = await prisma.user.findUnique({
          where: {id: regularUser.user.id}
        })
        expect(userFromDb!.roles).toMatchObject([
          {
            name: "WorkflowTemplateVoter",
            scope: {type: "workflow_template", templateName}
          }
        ])
      })

      it("should allow user with org-wide space manage permission to assign workflow template role", async () => {
        // Given: User with org-wide space manage permission
        const {token: orgWideManagerToken} = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
          orgAdmin: false,
          roles: [
            {
              name: "OrgWideSpaceManager",
              resourceType: "space",
              permissions: ["read", "manage"],
              scopeType: "org",
              scope: {type: "org", organizationId: targetUser.user.organizationId}
            }
          ]
        })

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                templateName: templateName
              }
            }
          ]
        }

        // When: Org-wide space manager assigns workflow template role
        const response = await put(app, userRolesEndpoint(regularUser.user.id))
          .withToken(orgWideManagerToken)
          .withHeader("If-Match", await ifMatchFor(regularUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Expect: Should succeed
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)
      })

      it("should deny regular user without space manage permission from assigning workflow template role", async () => {
        // Given: Regular user without any manage permissions
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                templateName: templateName
              }
            }
          ]
        }

        // When: Regular user tries to assign workflow template role
        const response = await put(app, userRolesEndpoint(orgAdminUser.user.id))
          .withToken(regularUser.token)
          .withHeader("If-Match", await ifMatchFor(orgAdminUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Expect: Should be denied with forbidden/unprocessable status
        expect([HttpStatus.FORBIDDEN, HttpStatus.UNPROCESSABLE_ENTITY]).toContain(response.status)
      })

      it("should deny space manager from assigning workflow template role for template in different space", async () => {
        // Given: Space manager trying to assign role for template in a different space they don't manage
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                templateName: workflowTemplateInOtherSpace
              }
            }
          ]
        }

        // When: Space manager tries to assign workflow template role for template in other space
        const response = await put(app, userRolesEndpoint(regularUser.user.id))
          .withToken(spaceManagerUser.token)
          .withHeader("If-Match", await ifMatchFor(regularUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Expect: Should be denied
        expect([HttpStatus.FORBIDDEN, HttpStatus.UNPROCESSABLE_ENTITY]).toContain(response.status)
      })

      it("should deny assignment of workflow template role for non-existent workflow template", async () => {
        // Given: Non-existent workflow template ID
        const nonExistentTemplateId = uuidv7()
        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "WorkflowTemplateVoter",
              scope: {
                type: "workflow_template",
                templateName: nonExistentTemplateId
              }
            }
          ]
        }

        // When: Space manager tries to assign role for non-existent template
        const response = await put(app, userRolesEndpoint(regularUser.user.id))
          .withToken(spaceManagerUser.token)
          .withHeader("If-Match", await ifMatchFor(regularUser.user.id))
          .build()
          .send(roleAssignmentRequest)

        // Expect: Should fail (either not found or authorization failure)
        expect(response.status).toBeGreaterThanOrEqual(400)
      })
    })
  })

  describe("DELETE /users/{userId}/roles", () => {
    describe("good cases", () => {
      it("should remove single role from user", async () => {
        // Given: User has roles assigned
        const group = await createTestGroup(prisma, {name: "Existing Role Scope"})
        await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "OrgWideSpaceManager",
                scope: {type: "org"}
              },
              {
                roleName: "GroupManager",
                scope: {type: "group", groupId: group.id}
              }
            ]
          })

        // When: Admin removes one role
        const response = await del(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "GroupManager",
                scope: {type: "group", groupId: group.id}
              }
            ]
          })

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Only the other role should remain in database
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toHaveLength(1)
        expect(userFromDb!.roles).toMatchObject([
          {
            name: "OrgWideSpaceManager",
            scope: {type: "org"}
          }
        ])
      })

      it("should remove multiple roles from user", async () => {
        // Given: User has multiple roles assigned
        const group1 = await createTestGroup(prisma, {name: "Group 1"})
        const group2 = await createTestGroup(prisma, {name: "Group 2"})
        await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "OrgWideSpaceManager",
                scope: {type: "org"}
              },
              {
                roleName: "GroupManager",
                scope: {type: "group", groupId: group1.id}
              },
              {
                roleName: "GroupReadOnly",
                scope: {type: "group", groupId: group2.id}
              }
            ]
          })

        // When: Admin removes multiple roles
        const response = await del(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "GroupManager",
                scope: {type: "group", groupId: group1.id}
              },
              {
                roleName: "GroupReadOnly",
                scope: {type: "group", groupId: group2.id}
              }
            ]
          })

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Only non-removed role should remain
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toHaveLength(1)
        expect(userFromDb!.roles).toMatchObject([
          {
            name: "OrgWideSpaceManager",
            scope: {type: "org"}
          }
        ])
      })

      it("should remove all roles from user", async () => {
        // Given: User has roles assigned
        await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "OrgWideSpaceManager",
                scope: {type: "org"}
              }
            ]
          })

        // When: Admin removes all roles
        const response = await del(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "OrgWideSpaceManager",
                scope: {type: "org"}
              }
            ]
          })

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: User should have no roles
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toHaveLength(0)
      })

      it("should handle removing non-existent role gracefully (no-op)", async () => {
        // Given: User has one role assigned
        const group = await createTestGroup(prisma, {name: "Test Group"})
        await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "GroupManager",
                scope: {type: "group", groupId: group.id}
              }
            ]
          })

        // When: Admin tries to remove a different role
        const response = await del(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "OrgWideSpaceManager",
                scope: {type: "org"}
              }
            ]
          })

        // Then: Should receive success response (no-op)
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Original role should still exist
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toHaveLength(1)
        expect(userFromDb!.roles).toMatchObject([
          {
            name: "GroupManager",
            scope: {type: "group", groupId: group.id}
          }
        ])
      })
    })

    describe("audit logging", () => {
      it("should persist audit log when roles are removed", async () => {
        // Given: User has roles assigned
        const group = await createTestGroup(prisma, {name: "Test Group"})
        await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "GroupManager",
                scope: {type: "group", groupId: group.id}
              }
            ]
          })

        // When: Admin removes role
        const response = await del(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "GroupManager",
                scope: {type: "group", groupId: group.id}
              }
            ]
          })

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Audit log should be persisted in database
        const auditLogs = await prisma.auditLog.findMany({
          where: {
            entityId: targetUser.user.id,
            auditType: "USER_ROLES_REMOVED"
          }
        })
        expect(auditLogs).toHaveLength(1)
        expect(auditLogs[0]!.payload).toMatchObject({
          roles: [
            {
              roleName: "GroupManager",
              scope: {type: "group", groupId: group.id}
            }
          ]
        })
      })

      it("should return 500 UNKNOWN_ERROR and not remove roles if audit log creation fails", async () => {
        const auditLogRepo = app.get<AuditLogRepository>(AUDIT_LOG_REPOSITORY_TOKEN)

        // Given: User has roles assigned
        const group = await createTestGroup(prisma, {name: "Test Group"})
        await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "GroupManager",
                scope: {type: "group", groupId: group.id}
              }
            ]
          })

        // And: Audit log persistence will fail
        failTaskEither(auditLogRepo, "persist", "unknown_error")

        // When: Admin removes role
        const response = await del(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "GroupManager",
                scope: {type: "group", groupId: group.id}
              }
            ]
          })

        // Then: Should receive 500 Unknown Error
        expect(response).toHaveStatusCode(HttpStatus.INTERNAL_SERVER_ERROR)

        // And: Roles should NOT be removed in database (transaction rollback)
        const userFromDb = await prisma.user.findUnique({
          where: {id: targetUser.user.id}
        })
        expect(userFromDb!.roles).toHaveLength(1)
      })

      it("should only log roles that were actually present and removed", async () => {
        // Given: User has "GroupReadOnly" role
        const group = await createTestGroup(prisma, {name: "Test Group"})
        await put(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "GroupReadOnly",
                scope: {type: "group", groupId: group.id}
              }
            ]
          })

        const otherGroup = await createTestGroup(prisma, {name: "Unassigned Role Scope"})

        // When: Admin requests to remove the same role from an existing and an unassigned group scope
        const response = await del(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send({
            roles: [
              {
                roleName: "GroupReadOnly",
                scope: {type: "group", groupId: group.id}
              },
              {
                roleName: "GroupReadOnly",
                scope: {type: "group", groupId: otherGroup.id}
              }
            ]
          })

        // Then: Should receive success response
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)

        // And: Audit log should only contain the removed role that was actually present
        const auditLogs = await prisma.auditLog.findMany({
          where: {
            entityId: targetUser.user.id,
            auditType: "USER_ROLES_REMOVED"
          }
        })
        expect(auditLogs).toHaveLength(1)
        expect(auditLogs[0]!.payload).toMatchObject({
          roles: [
            {
              roleName: "GroupReadOnly",
              scope: {type: "group", groupId: group.id}
            }
          ]
        })
      })
    })

    describe("bad cases", () => {
      it("should return 401 for unauthenticated requests", async () => {
        // Given: Valid role removal request but no auth token
        const roleRemovalRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "GroupReadOnly",
              scope: {type: "org"}
            }
          ]
        }

        // When: Making request without token
        const response = await del(app, userRolesEndpoint(targetUser.user.id)).build().send(roleRemovalRequest)

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return BAD REQUEST for invalid token", async () => {
        // Given: Valid role removal request but invalid token
        const roleRemovalRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "GroupReadOnly",
              scope: {type: "org"}
            }
          ]
        }

        // When: Making request with invalid token
        const response = await del(app, userRolesEndpoint(targetUser.user.id))
          .withToken("invalid-token")
          .build()
          .send(roleRemovalRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for empty roles array", async () => {
        // Given: Empty roles removal request
        const roleRemovalRequest: RoleAssignmentRequest = {
          roles: []
        }

        // When: Admin tries to remove empty roles
        const response = await del(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(roleRemovalRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 404 for non-existent user", async () => {
        // Given: Valid role removal request but non-existent user ID
        const roleRemovalRequest: RoleAssignmentRequest = {
          roles: [
            {
              roleName: "OrgWideSpaceReadOnly",
              scope: {type: "org"}
            }
          ]
        }

        const nonExistentUserId = uuidv7()

        // When: Admin tries to remove role from non-existent user
        const response = await del(app, userRolesEndpoint(nonExistentUserId))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(nonExistentUserId, 0n))
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
        const response = await del(app, userRolesEndpoint(targetUser.user.id))
          .withToken(orgAdminUser.token)
          .withHeader("If-Match", await ifMatchFor(targetUser.user.id))
          .build()
          .send(invalidRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })
    })
  })
})
