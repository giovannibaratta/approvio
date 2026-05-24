import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {USERS_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient} from "@prisma/client"

import {cleanDatabase, prepareDatabase} from "@test/database"
import {
  createDomainMockUserInDb,
  createTestGroup,
  createMockSpaceInDb,
  createMockWorkflowTemplateInDb,
  MockConfigProvider
} from "@test/mock-data"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {put, del} from "@test/requests"
import {UserWithToken} from "@test/types"
import "expect-more-jest"
import "@utils/matchers"
import {
  TokenPayloadBuilder,
  USER_REPOSITORY_TOKEN,
  UserRepository,
  AUDIT_LOG_REPOSITORY_TOKEN,
  AuditLogRepository
} from "@services"
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

  beforeAll(async () => {
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

    app = module.createNestApplication({logger: false})
    prisma = module.get(DatabaseClient).prisma
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)

    await app.init()
  }, 30000)

  beforeEach(async () => {
    const adminUser = await createDomainMockUserInDb(prisma, {orgAdmin: true})
    const userToAssignRoles = await createDomainMockUserInDb(prisma, {orgAdmin: false})

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

    orgAdminUser = {user: adminUser, token: createUserToken(adminUser)}
    targetUser = {user: userToAssignRoles, token: createUserToken(userToAssignRoles)}
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

  const createOrgScopeRequest = (roleName: string, occVersion = "-9223372036854775808"): RoleAssignmentRequest => ({
    concurrencyControl: {version: occVersion},
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
    occVersion = "-9223372036854775808"
  ): RoleAssignmentRequest => ({
    concurrencyControl: {version: occVersion},
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
    occVersion = "-9223372036854775808"
  ): RoleAssignmentRequest => ({
    concurrencyControl: {version: occVersion},
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
    occVersion = "-9223372036854775808"
  ): RoleAssignmentRequest => ({
    concurrencyControl: {version: occVersion},
    roles: [
      {
        roleName,
        scope: {type: "workflow_template", templateName}
      }
    ]
  })

  describe("PUT /users/{userId}/roles", () => {
    describe("good cases", () => {
      it("should add organization-wide role to user and persist in database", async () => {
        // Given: Valid role assignment request with org scope
        const roleAssignmentRequest = createOrgScopeRequest("OrgWideSpaceManager")

        // When: Admin assigns role to user
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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
            resourceType: "space",
            scopeType: "org",
            scope: {type: "org"},
            permissions: expect.any(Array)
          }
        ])
      })

      it("should add space-specific role to user and persist in database", async () => {
        // Given: Valid role assignment request with space scope
        const spaceId = uuidv7()
        const roleAssignmentRequest = createSpaceRequest("SpaceManager", spaceId)

        // When: Admin assigns space role to user
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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
            resourceType: "space",
            scopeType: "space",
            scope: {type: "space", spaceId: spaceId},
            permissions: expect.any(Array)
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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
            resourceType: "group",
            scopeType: "group",
            scope: {type: "group", groupId: group.id},
            permissions: expect.any(Array)
          }
        ])
      })

      it("should add multiple roles to user and persist in database", async () => {
        // Given: Valid role assignment request with multiple roles
        const group = await createTestGroup(prisma, {name: "Test Group"})

        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
          roles: [
            {roleName: "OrgWideSpaceReadOnly", scope: {type: "org"}},
            {roleName: "GroupReadOnly", scope: {type: "group", groupId: group.id}}
          ]
        }

        // When: Admin assigns multiple roles to user
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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
            resourceType: "space",
            scopeType: "org",
            scope: {type: "org"}
          },
          {
            name: "GroupReadOnly",
            resourceType: "group",
            scopeType: "group",
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

        await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(firstAssignment)

        // When: Admin adds additional roles
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const secondAssignment = createGroupRequest("GroupManager", group2.id, userToUpdate.occ.toString())

        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should handle maximum of 128 unique roles assignment with different scopes", async () => {
        // Given: Role assignment request with 128 unique roles (maximum allowed)
        const groups = []
        for (let i = 0; i < 127; i++) {
          const group = await createTestGroup(prisma, {name: `Group ${i}`})
          groups.push(group)
        }

        const roles = []
        // Add 127 group-specific roles
        for (let i = 0; i < 127; i++) {
          roles.push({
            roleName: "GroupReadOnly",
            scope: {
              type: "group" as const,
              groupId: groups[i]!.id
            }
          })
        }
        // Add 1 org-wide role
        roles.push({
          roleName: "OrgWideSpaceReadOnly",
          scope: {
            type: "org" as const
          }
        })

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles,
          concurrencyControl: {version: "-9223372036854775808"}
        }

        // When: Admin assigns maximum number of unique roles
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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

        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
          roles: [
            {roleName: "GroupReadOnly", scope: {type: "group", groupId: group.id}},
            {roleName: "GroupReadOnly", scope: {type: "group", groupId: group.id}},
            {roleName: "OrgWideSpaceReadOnly", scope: {type: "org"}}
          ]
        }

        // When: Admin assigns roles with duplicates
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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
        spy = wrapTaskEitherWithSideEffect(userRepository, "getUserById", async userId => {
          // Only trigger side effect if fetching the target user (prevent intercepting jwt validation)
          if (userId === targetUser.user.id) {
            // Manually increment the OCC in the database via raw prisma query
            // This simulates a concurrent update to the user between read and write
            await prisma.user.update({
              where: {id: targetUser.user.id},
              data: {occ: {increment: 1}}
            })
          }
        })

        // When: Admin assigns role to user
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return BAD REQUEST with invalid authentication token", async () => {
        // Given: Valid role assignment request but invalid token
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(authToken)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for empty roles array", async () => {
        // Given: Empty roles assignment request
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
          roles: []
        }

        // When: Admin tries to assign empty roles
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for unknown role name", async () => {
        // Given: Role assignment request with invalid role name
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for invalid UUID format in scope", async () => {
        // Given: Role assignment request with invalid UUID format
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 404 for non-existent user", async () => {
        // Given: Valid role assignment request but non-existent user ID
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${nonExistentUserId}/roles`)
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(invalidRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for role with incorrect scope type", async () => {
        // Given: Role assignment request with incompatible scope
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for exceeding maximum roles in request (129 roles)", async () => {
        // Given: Role assignment request with more than 128 roles
        const roles = []
        for (let i = 0; i < MAX_ROLES_PER_ENTITY + 1; i++) {
          roles.push({
            roleName: "OrgWideSpaceReadOnly",
            scope: {
              type: "org" as const
            }
          })
        }

        const roleAssignmentRequest: RoleAssignmentRequest = {
          roles,
          concurrencyControl: {version: "-9223372036854775808"}
        }

        // When: Admin tries to assign more than maximum allowed roles in single request
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 422 when total roles would exceed limit", async () => {
        // Given: User already has some roles assigned
        const existingRoles = []
        for (let i = 0; i < MAX_ROLES_PER_ENTITY; i++) {
          const group = await createTestGroup(prisma, {name: `Existing Group ${i}`})
          existingRoles.push({
            roleName: "GroupReadOnly",
            scope: {
              type: "group",
              groupId: group.id
            }
          })
        }

        // Assign existing roles
        await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: "-9223372036854775808"},
            roles: existingRoles
          })

        // When: Admin tries to add more roles that would exceed total limit
        const additionalRoles = []
        for (let i = 0; i < 5; i++) {
          const group = await createTestGroup(prisma, {name: `Additional Group ${i}`})
          additionalRoles.push({
            roleName: "GroupManager",
            scope: {
              type: "group",
              groupId: group.id
            }
          })
        }

        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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
        const managerUser = await createDomainMockUserInDb(prisma, {orgAdmin: false})
        const normalUser = await createDomainMockUserInDb(prisma, {orgAdmin: false})

        const createUserToken = (user: typeof managerUser) => {
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

        spaceManagerUser = {user: managerUser, token: createUserToken(managerUser)}
        regularUser = {user: normalUser, token: createUserToken(normalUser)}

        // Given: Assign space manager role to managerUser for Main Space
        await prisma.user.update({
          where: {id: managerUser.id},
          data: {
            roles: [
              {
                name: "SpaceManager",
                resourceType: "space",
                scopeType: "space",
                scope: {type: "space", spaceId: spaceId},
                permissions: ["read", "manage"]
              }
            ]
          }
        })
      })

      it("should allow org admin to assign workflow template role", async () => {
        // Given: Org admin wants to assign workflow template role
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${regularUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
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
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${regularUser.user.id}/roles`)
          .withToken(spaceManagerUser.token)
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

      it("should allow user with org-wide space manage permission to assign workflow template role", async () => {
        // Given: User with org-wide space manage permission
        const orgWideManagerUser = await createDomainMockUserInDb(prisma, {orgAdmin: false})
        await prisma.user.update({
          where: {id: orgWideManagerUser.id},
          data: {
            roles: [
              {
                name: "OrgWideSpaceManager",
                resourceType: "space",
                scopeType: "org",
                scope: {type: "org"},
                permissions: ["read", "manage"]
              }
            ]
          }
        })
        const orgWideManagerToken = jwtService.sign(
          TokenPayloadBuilder.from({
            sub: orgWideManagerUser.id,
            entityType: "user",
            displayName: orgWideManagerUser.displayName,
            email: orgWideManagerUser.email,
            issuer: configProvider.jwtConfig.issuer,
            audience: [configProvider.jwtConfig.audience]
          })
        )

        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${regularUser.user.id}/roles`)
          .withToken(orgWideManagerToken)
          .build()
          .send(roleAssignmentRequest)

        // Expect: Should succeed
        expect(response).toHaveStatusCode(HttpStatus.NO_CONTENT)
      })

      it("should deny regular user without space manage permission from assigning workflow template role", async () => {
        // Given: Regular user without any manage permissions
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${orgAdminUser.user.id}/roles`)
          .withToken(regularUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Expect: Should be denied with forbidden/unprocessable status
        expect([HttpStatus.FORBIDDEN, HttpStatus.UNPROCESSABLE_ENTITY]).toContain(response.status)
      })

      it("should deny space manager from assigning workflow template role for template in different space", async () => {
        // Given: Space manager trying to assign role for template in a different space they don't manage
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${regularUser.user.id}/roles`)
          .withToken(spaceManagerUser.token)
          .build()
          .send(roleAssignmentRequest)

        // Expect: Should be denied
        expect([HttpStatus.FORBIDDEN, HttpStatus.UNPROCESSABLE_ENTITY]).toContain(response.status)
      })

      it("should deny assignment of workflow template role for non-existent workflow template", async () => {
        // Given: Non-existent workflow template ID
        const nonExistentTemplateId = uuidv7()
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleAssignmentRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
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
        const response = await put(app, `/${USERS_ENDPOINT_ROOT}/${regularUser.user.id}/roles`)
          .withToken(spaceManagerUser.token)
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
        const group = await createTestGroup(prisma, {name: "Test Group"})
        await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: "-9223372036854775808"},
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
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const response = await del(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: userToUpdate.occ.toString()},
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
        await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: "-9223372036854775808"},
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
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const response = await del(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: userToUpdate.occ.toString()},
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
        await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: "-9223372036854775808"},
            roles: [
              {
                roleName: "OrgWideSpaceManager",
                scope: {type: "org"}
              }
            ]
          })

        // When: Admin removes all roles
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const response = await del(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: userToUpdate.occ.toString()},
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
        await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: "-9223372036854775808"},
            roles: [
              {
                roleName: "GroupManager",
                scope: {type: "group", groupId: group.id}
              }
            ]
          })

        // When: Admin tries to remove a different role
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const response = await del(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: userToUpdate.occ.toString()},
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
        await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: "-9223372036854775808"},
            roles: [
              {
                roleName: "GroupManager",
                scope: {type: "group", groupId: group.id}
              }
            ]
          })

        // When: Admin removes role
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const response = await del(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: userToUpdate.occ.toString()},
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
        await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: "-9223372036854775808"},
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
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const response = await del(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send({
            concurrencyControl: {version: userToUpdate.occ.toString()},
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
    })

    describe("bad cases", () => {
      it("should return 401 for unauthenticated requests", async () => {
        // Given: Valid role removal request but no auth token
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleRemovalRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
          roles: [
            {
              roleName: "GroupReadOnly",
              scope: {type: "org"}
            }
          ]
        }

        // When: Making request without token
        const response = await del(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .build()
          .send(roleRemovalRequest)

        // Then: Should receive unauthorized response
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return BAD REQUEST for invalid token", async () => {
        // Given: Valid role removal request but invalid token
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleRemovalRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
          roles: [
            {
              roleName: "GroupReadOnly",
              scope: {type: "org"}
            }
          ]
        }

        // When: Making request with invalid token
        const response = await del(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken("invalid-token")
          .build()
          .send(roleRemovalRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 400 for empty roles array", async () => {
        // Given: Empty roles removal request
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleRemovalRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
          roles: []
        }

        // When: Admin tries to remove empty roles
        const response = await del(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(roleRemovalRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should return 404 for non-existent user", async () => {
        // Given: Valid role removal request but non-existent user ID
        const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.user.id}})
        const roleRemovalRequest: RoleAssignmentRequest = {
          concurrencyControl: {version: userToUpdate.occ.toString()},
          roles: [
            {
              roleName: "OrgWideSpaceReadOnly",
              scope: {type: "org"}
            }
          ]
        }

        const nonExistentUserId = uuidv7()

        // When: Admin tries to remove role from non-existent user
        const response = await del(app, `/${USERS_ENDPOINT_ROOT}/${nonExistentUserId}/roles`)
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
        const response = await del(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.user.id}/roles`)
          .withToken(orgAdminUser.token)
          .build()
          .send(invalidRequest)

        // Then: Should receive bad request response
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })
    })
  })
})
