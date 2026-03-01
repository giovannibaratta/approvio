import {
  CanVoteResponse as CanVoteResponseApi,
  Workflow as WorkflowApi,
  WorkflowCreate,
  WorkflowVoteRequest as WorkflowVoteRequestApi,
  ListWorkflows200Response,
  GetWorkflowVotes200Response
} from "@approvio/api"
import {AppModule} from "@app/app.module"
import {WORKFLOWS_ENDPOINT_ROOT} from "@controllers"
import {SystemRole} from "@domain"
import {ApprovalRuleType, WORKFLOW_DESCRIPTION_MAX_LENGTH, WORKFLOW_NAME_MAX_LENGTH, WorkflowStatus} from "@domain"
import {DatabaseClient} from "@external"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient, Workflow as PrismaWorkflow, WorkflowTemplate as PrismaWorkflowTemplate} from "@prisma/client"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase, prepareRedisPrefix, cleanRedisByPrefix} from "@test/database"
import {
  createDomainMockUserInDb,
  createMockWorkflowInDb,
  createMockWorkflowTemplateInDb,
  MockConfigProvider,
  createUserWithRefreshToken
} from "@test/mock-data"
import {get, post} from "@test/requests"
import {UserWithToken} from "@test/types"
import {TokenPayloadBuilder} from "@services"
import {getQueueToken} from "@nestjs/bull"
import {WORKFLOW_STATUS_RECALCULATION_QUEUE} from "@external"
import {Queue} from "bull"

// Helper function to create a mock group for tests
async function createTestGroup(prisma: PrismaClient, name: string): Promise<{id: string}> {
  const group = await prisma.group.create({
    data: {
      id: randomUUID(),
      name: name,
      createdAt: new Date(),
      updatedAt: new Date(),
      occ: 1
    }
  })
  return group
}

async function addUserToGroup(prisma: PrismaClient, groupId: string, userId: string): Promise<void> {
  await prisma.user.update({
    where: {id: userId},
    data: {
      groupMemberships: {
        connectOrCreate: {
          where: {groupId_userId: {groupId, userId}},
          create: {groupId, createdAt: new Date(), updatedAt: new Date()}
        }
      }
    }
  })
  await prisma.groupMembership.upsert({
    where: {
      groupId_userId: {
        groupId: groupId,
        userId: userId
      }
    },
    update: {
      updatedAt: new Date()
    },
    create: {
      groupId: groupId,
      userId: userId,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  })
}

async function addVoterRoleToUser(prisma: PrismaClient, userId: string, workflowTemplateId: string): Promise<void> {
  const voterRole = SystemRole.createWorkflowTemplateVoterRole({
    type: "workflow_template",
    workflowTemplateId
  })
  const roleForDb = JSON.parse(JSON.stringify(voterRole))
  const user = await prisma.user.findUnique({where: {id: userId}})
  const roles = (user?.roles as unknown[]) || []
  await prisma.user.update({
    where: {id: userId},
    data: {roles: [...roles, roleForDb]}
  })
}

describe("Workflows API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let mockGroupId1: string
  let mockGroupId2: string
  let mockWorkflowTemplate: PrismaWorkflowTemplate
  let redisPrefix: string
  let recalculationQueue: Queue

  const endpoint = `/${WORKFLOWS_ENDPOINT_ROOT}`

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb, redisPrefix))
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication({logger: ["error", "warn"]})

    prisma = module.get(DatabaseClient)
    jwtService = module.get(JwtService)

    const adminUser = await createDomainMockUserInDb(prisma, {orgAdmin: true})
    const memberUser = await createDomainMockUserInDb(prisma, {orgAdmin: false})
    const testGroup1 = await createTestGroup(prisma, "Test-Approver-Group-1")
    const testGroup2 = await createTestGroup(prisma, "Test-Approver-Group-2")

    configProvider = module.get(ConfigProvider)
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
    mockGroupId1 = testGroup1.id
    mockGroupId2 = testGroup2.id

    mockWorkflowTemplate = await createMockWorkflowTemplateInDb(prisma, {
      approvalRule: {
        type: ApprovalRuleType.GROUP_REQUIREMENT,
        groupId: mockGroupId1,
        minCount: 1
      }
    })

    recalculationQueue = module.get<Queue>(getQueueToken(WORKFLOW_STATUS_RECALCULATION_QUEUE))
    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await cleanRedisByPrefix(redisPrefix)
    await app.close()
  })

  it("should be defined", () => {
    expect(app).toBeDefined()
    expect(recalculationQueue).toBeDefined()
  })

  describe("POST /workflows", () => {
    describe("good cases", () => {
      it("should create a workflow and return 201 with location header (as OrgAdmin)", async () => {
        // Given: a workflow creation request
        const requestBody: WorkflowCreate = {
          name: "Test-Workflow-1",
          description: "A test description for workflow",
          workflowTemplateId: mockWorkflowTemplate.id
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 201 Created status and a location header
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.headers.location).toMatch(new RegExp(`${endpoint}/[a-f0-9-]+`))

        // And: the workflow should exist in the database with correct details
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const workflowDbObject = await prisma.workflow.findUnique({
          where: {id: responseUuid}
        })
        expect(workflowDbObject).toBeDefined()
        expect(workflowDbObject?.name).toEqual(requestBody.name)
        expect(workflowDbObject?.description).toEqual(requestBody.description)
        expect(workflowDbObject?.id).toEqual(responseUuid)
      })

      it("should create a workflow with null description if not provided (as OrgAdmin)", async () => {
        // Given: a workflow creation request without a description
        const requestBody: WorkflowCreate = {
          name: "Minimal-Workflow",
          workflowTemplateId: mockWorkflowTemplate.id
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 201 Created status and the workflow in DB should have a null description
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const workflowDbObject = await prisma.workflow.findUnique({where: {id: responseUuid}})
        expect(workflowDbObject?.description).toBeNull()
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // Given: a workflow creation request
        const requestBody: WorkflowCreate = {
          name: "Unauthorized-Workflow",
          workflowTemplateId: mockWorkflowTemplate.id
        }

        // When: the request is sent without a token
        const response = await post(app, endpoint).build().send(requestBody)

        // Expect: a 401 Unauthorized status
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 409 CONFLICT (WORKFLOW_ALREADY_EXISTS) if a workflow with the same name exists (as OrgAdmin)", async () => {
        // Given: a workflow with the same name already exists
        const requestBody: WorkflowCreate = {
          name: "Duplicate-Workflow-Name",
          workflowTemplateId: mockWorkflowTemplate.id
        }
        await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // When: another request is sent to create a workflow with the same name
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 409 Conflict status with WORKFLOW_ALREADY_EXISTS error code
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body).toHaveErrorCode("WORKFLOW_ALREADY_EXISTS")
      })

      it("should return 400 BAD_REQUEST (WORKFLOW_NAME_EMPTY) if name is empty (as OrgAdmin)", async () => {
        // Given: a workflow creation request with an empty name
        const requestBody: WorkflowCreate = {
          name: " ", // Whitespace only
          workflowTemplateId: mockWorkflowTemplate.id
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with WORKFLOW_NAME_EMPTY error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_NAME_EMPTY")
      })

      it("should return 400 BAD_REQUEST (WORKFLOW_NAME_INVALID_CHARACTERS) if name has invalid characters (as OrgAdmin)", async () => {
        // Given: a workflow creation request with invalid characters in the name
        const requestBody: WorkflowCreate = {
          name: "Invalid Name!", // Contains '!'
          workflowTemplateId: mockWorkflowTemplate.id
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with WORKFLOW_NAME_INVALID_CHARACTERS error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_NAME_INVALID_CHARACTERS")
      })

      it("should return 400 BAD_REQUEST (WORKFLOW_NAME_TOO_LONG) if name is too long (as OrgAdmin)", async () => {
        // Given: a workflow creation request with a name that is too long
        const requestBody: WorkflowCreate = {
          name: "a".repeat(WORKFLOW_NAME_MAX_LENGTH + 1),
          workflowTemplateId: mockWorkflowTemplate.id
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with WORKFLOW_NAME_TOO_LONG error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_NAME_TOO_LONG")
      })

      it("should return 400 BAD_REQUEST (WORKFLOW_DESCRIPTION_TOO_LONG) if description is too long (as OrgAdmin)", async () => {
        // Given: a workflow creation request with a description that is too long
        const requestBody: WorkflowCreate = {
          name: "Long-Description-Workflow",
          description: "d".repeat(WORKFLOW_DESCRIPTION_MAX_LENGTH + 1),
          workflowTemplateId: mockWorkflowTemplate.id
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with WORKFLOW_DESCRIPTION_TOO_LONG error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_DESCRIPTION_TOO_LONG")
      })
    })
  })

  describe("GET /workflows/:workflowIdentifier", () => {
    let testWorkflow: PrismaWorkflow

    beforeEach(async () => {
      testWorkflow = await createMockWorkflowInDb(prisma, {
        name: "Specific-Workflow",
        description: "Details for specific workflow",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
    })

    describe("good cases", () => {
      it("should return workflow details when fetching by ID (as OrgAdmin)", async () => {
        // When: a request is sent to get workflow details by ID with an OrgAdmin token
        const response = await get(app, `${endpoint}/${testWorkflow.id}`).withToken(orgAdminUser.token).build()

        // Expect: a 200 OK status and the response body to match the created workflow details
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowApi = response.body
        expect(body.id).toEqual(testWorkflow.id)
        expect(body.name).toEqual(testWorkflow.name)
        expect(body.description).toEqual(testWorkflow.description)
        expect(body.status).toEqual(testWorkflow.status)
        expect(body.createdAt).toBeDefined()
        expect(body.updatedAt).toBeDefined()
      })

      it("should return workflow details when fetching by name (as OrgAdmin)", async () => {
        // When: a request is sent to get workflow details by name with an OrgAdmin token
        const response = await get(app, `${endpoint}/${testWorkflow.name}`).withToken(orgAdminUser.token).build()

        // Expect: a 200 OK status and the response body to match the created workflow details
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowApi = response.body
        expect(body.id).toEqual(testWorkflow.id)
        expect(body.name).toEqual(testWorkflow.name)
      })

      it("should return workflow details if OrgMember (assuming OrgMembers can view workflows)", async () => {
        // When: a request is sent to get workflow details by ID with an OrgMember token
        const response = await get(app, `${endpoint}/${testWorkflow.id}`).withToken(orgMemberUser.token).build()

        // Expect: a 200 OK status and the response body to contain the workflow ID
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowApi = response.body
        expect(body.id).toEqual(testWorkflow.id)
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When: a request is sent without a token
        const response = await get(app, `${endpoint}/${testWorkflow.id}`).build()

        // Expect: a 401 Unauthorized status
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 404 NOT_FOUND (WORKFLOW_NOT_FOUND) when fetching non-existent ID (as OrgAdmin)", async () => {
        // Given: a non-existent workflow ID
        const nonExistentId = randomUUID()

        // When: a request is sent to get workflow details by the non-existent ID with an OrgAdmin token
        const response = await get(app, `${endpoint}/${nonExistentId}`).withToken(orgAdminUser.token).build()

        // Expect: a 404 Not Found status with WORKFLOW_NOT_FOUND error code
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("WORKFLOW_NOT_FOUND")
      })

      it("should return 404 NOT_FOUND (WORKFLOW_NOT_FOUND) when fetching non-existent name (as OrgAdmin)", async () => {
        // Given: a non-existent workflow name
        const nonExistentName = "non-existent-workflow-name-abc"

        // When: a request is sent to get workflow details by the non-existent name with an OrgAdmin token
        const response = await get(app, `${endpoint}/${nonExistentName}`).withToken(orgAdminUser.token).build()

        // Expect: a 404 Not Found status with WORKFLOW_NOT_FOUND error code
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("WORKFLOW_NOT_FOUND")
      })
    })
  })

  describe("GET /workflows/:workflowId/canVote", () => {
    let testWorkflow: PrismaWorkflow
    let workflowRequiringGroup1: PrismaWorkflow
    let template: PrismaWorkflowTemplate

    beforeEach(async () => {
      // Given: a workflow that requires a specific group for voting and a user added to that group
      template = await createMockWorkflowTemplateInDb(prisma, {
        approvalRule: {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId: mockGroupId1,
          minCount: 1
        }
      })

      workflowRequiringGroup1 = await createMockWorkflowInDb(prisma, {
        name: "Workflow-Group1-Req",
        description: "Workflow requiring group 1",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        workflowTemplateId: template.id
      })
      await addUserToGroup(prisma, mockGroupId1, orgMemberUser.user.id)
      await addUserToGroup(prisma, mockGroupId1, orgAdminUser.user.id)

      // Add voter roles for this workflow template
      await addVoterRoleToUser(prisma, orgMemberUser.user.id, template.id)
      await addVoterRoleToUser(prisma, orgAdminUser.user.id, template.id)

      // Given: a generic workflow for other tests (e.g., admin access)
      testWorkflow = await createMockWorkflowInDb(prisma, {
        name: "Generic-Workflow-For-CanVote"
      })
    })

    describe("good cases", () => {
      it("should return 200 OK with canVote:true for a user in the required group (as OrgMember)", async () => {
        // When: a request is sent to check voting eligibility with an OrgMember token who is in the required group
        const response = await get(app, `${endpoint}/${workflowRequiringGroup1.id}/canVote`)
          .withToken(orgMemberUser.token)
          .build()

        // Expect: a 200 OK status with canVote set to true and VOTE_PENDING status
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: CanVoteResponseApi = response.body
        expect(body.canVote).toBe(true)
        expect(body.voteStatus).toEqual("VOTE_PENDING")
        expect(body.requireHighPrivilege).toBe(false)
        expect(body.cantVoteReason).toBeUndefined()
      })

      it("should return 200 OK with requireHighPrivilege: true if workflow requires it", async () => {
        const highPrivTemplate = await createMockWorkflowTemplateInDb(prisma, {
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: mockGroupId1,
            minCount: 1,
            requireHighPrivilege: true
          }
        })

        const workflowHighPriv = await createMockWorkflowInDb(prisma, {
          name: "HighPrivWorkflow",
          status: WorkflowStatus.EVALUATION_IN_PROGRESS,
          workflowTemplateId: highPrivTemplate.id
        })

        // Also add user as voter
        await addVoterRoleToUser(prisma, orgMemberUser.user.id, highPrivTemplate.id)

        // Add user to required group
        await addUserToGroup(prisma, mockGroupId1, orgMemberUser.user.id)

        const response = await get(app, `${endpoint}/${workflowHighPriv.id}/canVote`)
          .withToken(orgMemberUser.token)
          .build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: CanVoteResponseApi = response.body
        expect(body.canVote).toBe(true)
        expect(body.requireHighPrivilege).toBe(true)
      })

      it("should return 200 OK with requireHighPrivilege: true if workflow uses AND rule and only one requires high privilege", async () => {
        const complexTemplate = await createMockWorkflowTemplateInDb(prisma, {
          approvalRule: {
            type: ApprovalRuleType.AND,
            rules: [
              {
                type: ApprovalRuleType.GROUP_REQUIREMENT,
                groupId: mockGroupId1,
                minCount: 1,
                requireHighPrivilege: true
              },
              {
                type: ApprovalRuleType.GROUP_REQUIREMENT,
                groupId: mockGroupId2,
                minCount: 1,
                requireHighPrivilege: false
              }
            ]
          }
        })

        const complexWorkflow = await createMockWorkflowInDb(prisma, {
          name: "ComplexWorkflow",
          status: WorkflowStatus.EVALUATION_IN_PROGRESS,
          workflowTemplateId: complexTemplate.id
        })

        // Give OrgMember voter role
        await addVoterRoleToUser(prisma, orgMemberUser.user.id, complexTemplate.id)

        // Test user only in group 1 (Requires High Privilege)
        await addUserToGroup(prisma, mockGroupId1, orgMemberUser.user.id)

        const response1 = await get(app, `${endpoint}/${complexWorkflow.id}/canVote`)
          .withToken(orgMemberUser.token)
          .build()

        expect(response1).toHaveStatusCode(HttpStatus.OK)
        const body1: CanVoteResponseApi = response1.body
        expect(body1.canVote).toBe(true)
        expect(body1.requireHighPrivilege).toBe(true) // Required because they vote for group 1

        // Test user only in group 2 (Does NOT require High Privilege)
        const orgMember2User = await createUserWithRefreshToken(prisma, {
          userOverrides: {
            orgAdmin: false,
            roles: [
              SystemRole.createWorkflowTemplateVoterRole({
                type: "workflow_template",
                workflowTemplateId: complexTemplate.id
              })
            ]
          },
          tokenOverrides: {createdAt: new Date()}
        })
        const member2TokenPayload = TokenPayloadBuilder.fromUser(orgMember2User.user, {
          issuer: configProvider.jwtConfig.issuer,
          audience: [configProvider.jwtConfig.audience]
        })
        const member2Token = jwtService.sign(member2TokenPayload)

        await addUserToGroup(prisma, mockGroupId2, orgMember2User.user.id)

        const response2 = await get(app, `${endpoint}/${complexWorkflow.id}/canVote`).withToken(member2Token).build()

        expect(response2).toHaveStatusCode(HttpStatus.OK)
        const body2: CanVoteResponseApi = response2.body
        expect(body2.canVote).toBe(true)
        expect(body2.requireHighPrivilege).toBe(false) // Not required because they vote for group 2
      })

      it("should return 200 OK with canVote:true for OrgAdmin if they are part of a group", async () => {
        // Given: OrgAdmin is added to the required group
        await addUserToGroup(prisma, mockGroupId1, orgAdminUser.user.id)

        // When: a request is sent to check voting eligibility with an OrgAdmin token
        const response = await get(app, `${endpoint}/${workflowRequiringGroup1.id}/canVote`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: a 200 OK status with canVote set to true and VOTE_PENDING status
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: CanVoteResponseApi = response.body
        expect(body.canVote).toBe(true)
        expect(body.voteStatus).toEqual("VOTE_PENDING")
        expect(body.cantVoteReason).toBeUndefined()
      })

      it("should return 200 OK with canVote:false if user is not in the required group", async () => {
        // Given: a new user with voter role but not in any group related to this workflow
        const voterRole = SystemRole.createWorkflowTemplateVoterRole({
          type: "workflow_template",
          workflowTemplateId: template.id
        })
        const nonMemberUser = await createDomainMockUserInDb(prisma, {
          orgAdmin: false,
          roles: [voterRole]
        })
        const nonMemberTokenPayload = TokenPayloadBuilder.fromUser(nonMemberUser, {
          issuer: configProvider.jwtConfig.issuer,
          audience: [configProvider.jwtConfig.audience]
        })
        const nonMemberToken = jwtService.sign(nonMemberTokenPayload)

        // When: a request is sent to check voting eligibility with the non-member user's token
        const response = await get(app, `${endpoint}/${workflowRequiringGroup1.id}/canVote`)
          .withToken(nonMemberToken)
          .build()

        // Expect: a 200 OK status with canVote set to false
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: CanVoteResponseApi = response.body
        expect(body.canVote).toBe(false)
        expect(body.cantVoteReason).toEqual("ENTITY_NOT_IN_GROUP")
      })

      it("should return 200 OK with canVote:false if workflow has expired", async () => {
        // Given: a workflow with an expired date
        const expiredWorkflow = await createMockWorkflowInDb(prisma, {
          name: "Expired-Workflow",
          status: WorkflowStatus.EVALUATION_IN_PROGRESS,
          expiresAt: new Date(Date.now() - 1000)
        })

        // When: a request is sent to check voting eligibility with an OrgMember token
        const response = await get(app, `${endpoint}/${expiredWorkflow.id}/canVote`)
          .withToken(orgMemberUser.token)
          .build()

        // Expect: a 200 OK status with canVote set to false
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: CanVoteResponseApi = response.body
        expect(body.canVote).toBe(false)
        expect(body.cantVoteReason).toEqual("WORKFLOW_EXPIRED")
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When: a request is sent to check voting eligibility without a token
        const response = await get(app, `${endpoint}/${testWorkflow.id}/canVote`).build()

        // Expect: a 401 Unauthorized status
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 400 BAD_REQUEST if workflow does not exist", async () => {
        // Given: a non-existent workflow ID
        const nonExistentWorkflowId = randomUUID()

        // When: a request is sent to check voting eligibility for the non-existent workflow with an OrgAdmin token
        const response = await get(app, `${endpoint}/${nonExistentWorkflowId}/canVote`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: a 400 Bad Request status with WORKFLOW_NOT_FOUND error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_NOT_FOUND")
      })
    })
  })

  describe("POST /workflows/:workflowId/vote", () => {
    let workflowTemplate: PrismaWorkflowTemplate

    beforeEach(async () => {
      workflowTemplate = await createMockWorkflowTemplateInDb(prisma, {
        approvalRule: {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId: mockGroupId1,
          minCount: 2
        }
      })
    })

    describe("good cases", () => {
      let workflowForVoting: PrismaWorkflow
      beforeEach(async () => {
        workflowForVoting = await createMockWorkflowInDb(prisma, {
          name: "Workflow-For-Actual-Voting",
          description: "Voting Test",
          status: WorkflowStatus.EVALUATION_IN_PROGRESS,
          workflowTemplateId: workflowTemplate.id,
          expiresAt: "active"
        })
        await addUserToGroup(prisma, mockGroupId1, orgMemberUser.user.id)
        await addUserToGroup(prisma, mockGroupId1, orgAdminUser.user.id)

        // Add voter roles for the workflow template
        await addVoterRoleToUser(prisma, orgMemberUser.user.id, workflowTemplate.id)
        await addVoterRoleToUser(prisma, orgAdminUser.user.id, workflowTemplate.id)
      })

      it("should allow OrgMember in the group to APPROVE a workflow and return 200 OK", async () => {
        // Given: a request body to approve the workflow
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId1]
          }
        }

        // When: the OrgMember sends a vote request
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(orgMemberUser.token)
          .build()
          .send(requestBody)

        // Expect: a 202 Accepted status and the vote recorded in the database
        expect(response).toHaveStatusCode(HttpStatus.ACCEPTED)
        const voteInDb = await prisma.vote.findFirst({
          where: {workflowId: workflowForVoting.id, userId: orgMemberUser.user.id}
        })
        expect(voteInDb).toBeDefined()
        expect(voteInDb?.voteType).toEqual("APPROVE")
      })

      it("should allow OrgAdmin in the group to VETO a workflow and return 200 OK", async () => {
        // Given: a request body to veto the workflow with a reason
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {type: "VETO"},
          reason: "Admin vetoed"
        }

        // When: the OrgAdmin sends a vote request
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect: a 202 Accepted status
        expect(response).toHaveStatusCode(HttpStatus.ACCEPTED)
      })

      it("should be possible to vote multiple times", async () => {
        // Given: a request body to approve the workflow
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId1]
          }
        }

        // When: the OrgMember sends multiple vote requests
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(orgMemberUser.token)
          .build()
          .send(requestBody)

        // Sanity check: the first vote should be recorded in the database
        expect(response).toHaveStatusCode(HttpStatus.ACCEPTED)

        const response2 = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(orgMemberUser.token)
          .build()
          .send(requestBody)

        // Expect: multiple votes recorded in the database
        expect(response2).toHaveStatusCode(HttpStatus.ACCEPTED)
        const voteInDb = await prisma.vote.findMany({
          where: {workflowId: workflowForVoting.id, userId: orgMemberUser.user.id}
        })
        expect(voteInDb).toHaveLength(2)
      })

      it("should allow create a recalculation task if vote is successful", async () => {
        // Given: a request body to approve the workflow
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId1]
          }
        }

        // When: the OrgMember sends a vote request
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(orgMemberUser.token)
          .build()
          .send(requestBody)

        // Expect: a 202 Accepted status and the vote recorded in the database
        expect(response).toHaveStatusCode(HttpStatus.ACCEPTED)

        const tasks = await recalculationQueue.getWaiting()

        expect(tasks).toHaveLength(1)
        expect(tasks[0]).toMatchObject({data: {workflowId: workflowForVoting.id}})
      })

      it("should enforce high privilege correctly for complex AND rules based on voted groups", async () => {
        const complexTemplate = await createMockWorkflowTemplateInDb(prisma, {
          approvalRule: {
            type: ApprovalRuleType.AND,
            rules: [
              {
                type: ApprovalRuleType.GROUP_REQUIREMENT,
                groupId: mockGroupId1,
                minCount: 1,
                requireHighPrivilege: true
              },
              {
                type: ApprovalRuleType.GROUP_REQUIREMENT,
                groupId: mockGroupId2,
                minCount: 1,
                requireHighPrivilege: false
              }
            ]
          }
        })

        const complexWorkflow = await createMockWorkflowInDb(prisma, {
          name: "ComplexWorkflowVoting",
          status: WorkflowStatus.EVALUATION_IN_PROGRESS,
          workflowTemplateId: complexTemplate.id
        })

        await addVoterRoleToUser(prisma, orgMemberUser.user.id, complexTemplate.id)

        // Test user only in group 1 (Requires High Privilege)
        await addUserToGroup(prisma, mockGroupId1, orgMemberUser.user.id)

        const requestBody1: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId1]
          }
        }

        const response1 = await post(app, `${endpoint}/${complexWorkflow.id}/vote`)
          .withToken(orgMemberUser.token)
          .build()
          .send(requestBody1)

        // Fails because the member doesn't have a high privilege token
        expect(response1).toHaveStatusCode(HttpStatus.FORBIDDEN)
        expect(response1.body).toHaveErrorCode("STEP_UP_CONTEXT_MISSING")

        // Test user only in group 2 (Does NOT require High Privilege)
        const orgMember2User = await createUserWithRefreshToken(prisma, {
          userOverrides: {
            orgAdmin: false,
            roles: [
              SystemRole.createWorkflowTemplateVoterRole({
                type: "workflow_template",
                workflowTemplateId: complexTemplate.id
              })
            ]
          },
          tokenOverrides: {createdAt: new Date()}
        })

        const member2TokenPayload = TokenPayloadBuilder.fromUser(orgMember2User.user, {
          issuer: configProvider.jwtConfig.issuer,
          audience: [configProvider.jwtConfig.audience]
        })
        const member2Token = jwtService.sign(member2TokenPayload)

        await addUserToGroup(prisma, mockGroupId2, orgMember2User.user.id)

        const requestBody2: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId2]
          }
        }

        const response2 = await post(app, `${endpoint}/${complexWorkflow.id}/vote`)
          .withToken(member2Token)
          .build()
          .send(requestBody2)

        // Succeeds because group 2 doesn't require high privilege
        expect(response2).toHaveStatusCode(HttpStatus.ACCEPTED)
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // Given: a vote request body
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId1]
          }
        }

        // When: the vote request is sent without a token
        const response = await post(app, `${endpoint}/random-id/vote`).build().send(requestBody)

        // Expect: a 401 Unauthorized status
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 400 BAD_REQUEST if workflow does not exist", async () => {
        // Given: a non-existent workflow ID and a vote request body
        const nonExistentWorkflowId = randomUUID()
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId1]
          }
        }

        // When: a vote request is sent for the non-existent workflow with an OrgAdmin token
        const response = await post(app, `${endpoint}/${nonExistentWorkflowId}/vote`)
          .withToken(orgAdminUser.token)
          .build()
          .send(requestBody)

        // Expect: a 400 Bad Request status with WORKFLOW_NOT_FOUND error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_NOT_FOUND")
      })

      it("should return 422 UNPROCESSABLE_ENTITY if user is not eligible to vote (not in group)", async () => {
        const workflow = await createMockWorkflowInDb(prisma, {
          name: "Workflow-For-Actual-Voting",
          description: "Voting Test",
          status: WorkflowStatus.EVALUATION_IN_PROGRESS,
          workflowTemplateId: workflowTemplate.id,
          expiresAt: "active"
        })

        // Given: a new user not in any group related to this workflow
        const voterRole = SystemRole.createWorkflowTemplateVoterRole({
          type: "workflow_template",
          workflowTemplateId: workflowTemplate.id
        })
        const nonVoter = await createDomainMockUserInDb(prisma, {
          orgAdmin: false,
          roles: [voterRole]
        })
        const nonVoterTokenPayload = TokenPayloadBuilder.fromUser(nonVoter, {
          issuer: configProvider.jwtConfig.issuer,
          audience: [configProvider.jwtConfig.audience]
        })
        const nonVoterToken = jwtService.sign(nonVoterTokenPayload)
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId1]
          }
        }

        // When: the vote request is sent with the non-voter user's token
        const response = await post(app, `${endpoint}/${workflow.id}/vote`)
          .withToken(nonVoterToken)
          .build()
          .send(requestBody)

        expect(response).toHaveStatusCode(HttpStatus.UNPROCESSABLE_ENTITY)
        expect(response.body).toHaveErrorCode("ENTITY_NOT_IN_REQUIRED_GROUP")
      })

      it("should return 403 FORBIDDEN if voting without high privilege token when required", async () => {
        const highPrivTemplate = await createMockWorkflowTemplateInDb(prisma, {
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: mockGroupId1,
            minCount: 1,
            requireHighPrivilege: true
          }
        })

        const workflowHighPriv = await createMockWorkflowInDb(prisma, {
          name: "HighPrivWorkflow-Vote",
          description: "Voting Test Priv",
          status: WorkflowStatus.EVALUATION_IN_PROGRESS,
          workflowTemplateId: highPrivTemplate.id,
          expiresAt: "active"
        })

        // Give user permission to vote on this generic template too
        await addVoterRoleToUser(prisma, orgMemberUser.user.id, highPrivTemplate.id)

        await addUserToGroup(prisma, mockGroupId1, orgMemberUser.user.id)

        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId1]
          }
        }

        const response = await post(app, `${endpoint}/${workflowHighPriv.id}/vote`)
          .withToken(orgMemberUser.token)
          .build()
          .send(requestBody)

        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
        expect(response.body).toHaveErrorCode("STEP_UP_CONTEXT_MISSING")
      })

      it("should return 400 BAD_REQUEST for invalid voteType", async () => {
        // Given: a request body with an invalid vote type
        const requestBody = {
          voteType: {
            type: "MAYBE_LATER"
          }
        }

        // When: the vote request is sent with a user who can normally vote
        const response = await post(app, `${endpoint}/a-workflow/vote`)
          .withToken(orgMemberUser.token)
          .build()
          .send(requestBody)

        // Expect: a 400 Bad Request status with INVALID_VOTE_TYPE error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("VOTE_TYPE_INVALID")
      })
    })
  })

  describe("GET /workflows", () => {
    beforeEach(async () => {
      await createMockWorkflowInDb(prisma, {
        name: "Terminal-Workflow",
        description: "A workflow in terminal state",
        status: WorkflowStatus.APPROVED
      })

      await createMockWorkflowInDb(prisma, {
        name: "Non-Terminal-Workflow",
        description: "A workflow in non-terminal state",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
    })

    describe("good cases", () => {
      it("should return workflows filtered by workflowTemplateIdentifier as UUID", async () => {
        // Given: a new workflow template and workflow
        const template = await createMockWorkflowTemplateInDb(prisma, {
          name: "Template-For-UUID-Filter",
          status: "ACTIVE"
        })
        await createMockWorkflowInDb(prisma, {
          name: "Workflow-With-UUID-Template",
          description: "A workflow associated with a specific template",
          status: WorkflowStatus.APPROVED,
          workflowTemplateId: template.id
        })

        // When: requesting workflows filtered by template UUID
        const response = await get(app, `${endpoint}?workflowTemplateIdentifier=${template.id}`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: only the workflow matching the template UUID is returned
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflows200Response = response.body
        expect(body.data).toHaveLength(1)
        expect(body.data[0]?.name).toEqual("Workflow-With-UUID-Template")
      })

      it("should return workflows filtered by workflowTemplateIdentifier as Name", async () => {
        // Given: a new workflow template and workflow
        const template = await createMockWorkflowTemplateInDb(prisma, {
          name: "Template-For-Name-Filter",
          status: "ACTIVE"
        })
        await createMockWorkflowInDb(prisma, {
          name: "Workflow-With-Name-Template",
          description: "A workflow associated with a specific template",
          status: WorkflowStatus.APPROVED,
          workflowTemplateId: template.id
        })

        // When: requesting workflows filtered by template name
        const response = await get(app, `${endpoint}?workflowTemplateIdentifier=${template.name}`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: only the workflow matching the template name is returned
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflows200Response = response.body
        expect(body.data).toHaveLength(1)
        expect(body.data[0]?.name).toEqual("Workflow-With-Name-Template")
      })

      it("should return an empty list if workflowTemplateIdentifier does not match", async () => {
        // When: requesting workflows filtered by an unknown template name
        const response = await get(app, `${endpoint}?workflowTemplateIdentifier=Non-Existent-Template`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: an empty list is returned
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflows200Response = response.body
        expect(body.data).toHaveLength(0)
      })

      it("should return all workflows without filter (as OrgAdmin)", async () => {
        // When: a request is sent to list workflows without filter
        const response = await get(app, endpoint).withToken(orgAdminUser.token).build()

        // Expect: a 200 OK status and all workflows in the response
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflows200Response = response.body
        expect(body.data).toHaveLength(2)
        expect(body.data.map(w => w.name)).toContain("Terminal-Workflow")
        expect(body.data.map(w => w.name)).toContain("Non-Terminal-Workflow")
      })

      it("should return only non-terminal workflows when include-only-non-terminal-state filter is true (as OrgAdmin)", async () => {
        // When: a request is sent to list workflows with include-only-non-terminal-state=true
        const response = await get(app, `${endpoint}?include-only-non-terminal-state=true`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: a 200 OK status and only non-terminal workflows in the response
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflows200Response = response.body
        expect(body.data).toHaveLength(1)
        expect(body.data[0]?.name).toEqual("Non-Terminal-Workflow")
        expect(body.data[0]?.status).toEqual(WorkflowStatus.EVALUATION_IN_PROGRESS)
      })

      it("should return all workflows when include-only-non-terminal-state filter is false (as OrgAdmin)", async () => {
        // When: a request is sent to list workflows with include-only-non-terminal-state=false
        const response = await get(app, `${endpoint}?include-only-non-terminal-state=false`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: a 200 OK status and all workflows in the response
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflows200Response = response.body
        expect(body.data).toHaveLength(2)
      })

      it("should work with pagination and the non-terminal filter (as OrgAdmin)", async () => {
        // When: a request is sent with pagination and the non-terminal filter
        const response = await get(app, `${endpoint}?page=1&limit=10&include-only-non-terminal-state=true`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: a 200 OK status and only non-terminal workflows with correct pagination
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflows200Response = response.body
        expect(body.data).toHaveLength(1)
        expect(body.pagination.total).toEqual(1)
        expect(body.pagination.page).toEqual(1)
        expect(body.pagination.limit).toEqual(10)
      })

      it("should return the workflows with also the workflow template", async () => {
        // When: a request is sent to list workflows with a valid include
        const response = await get(app, `${endpoint}?include=workflow-template`).withToken(orgAdminUser.token).build()

        // Expect: a 200 OK status and all workflows in the response
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflows200Response = response.body
        expect(body.data).toHaveLength(2)
        expect(body.data[0]?.ref?.workflowTemplate).not.toBeNull()
        expect(body.data[1]?.ref?.workflowTemplate).not.toBeNull()
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When: a request is sent without a token
        const response = await get(app, endpoint).build()

        // Expect: a 401 Unauthorized status
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 400 BAD_REQUEST for invalid include", async () => {
        // When: a request is sent to list workflows with an invalid include
        const response = await get(app, `${endpoint}?include=invalid`).withToken(orgAdminUser.token).build()

        // Expect: a 400 BAD_REQUEST status with REQUEST_INVALID_INCLUDE error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("REQUEST_INVALID_INCLUDE")
      })
    })
  })

  describe("GET /workflows/:workflowId/votes", () => {
    let workflowWithVotes: PrismaWorkflow
    let workflowTemplate: PrismaWorkflowTemplate

    beforeEach(async () => {
      workflowTemplate = await createMockWorkflowTemplateInDb(prisma, {
        approvalRule: {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId: mockGroupId1,
          minCount: 1
        }
      })

      workflowWithVotes = await createMockWorkflowInDb(prisma, {
        name: "Workflow-With-Votes",
        description: "Votes Test",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        workflowTemplateId: workflowTemplate.id
      })

      await addUserToGroup(prisma, mockGroupId1, orgMemberUser.user.id)

      // Add voter roles
      await addVoterRoleToUser(prisma, orgMemberUser.user.id, workflowTemplate.id)

      // Cast a vote
      const voteRequest: WorkflowVoteRequestApi = {
        voteType: {
          type: "APPROVE",
          votedForGroups: [mockGroupId1]
        },
        reason: "Looks good"
      }
      await post(app, `${endpoint}/${workflowWithVotes.id}/vote`)
        .withToken(orgMemberUser.token)
        .build()
        .send(voteRequest)
    })

    describe("good cases", () => {
      it("should list votes for a workflow (as OrgAdmin)", async () => {
        // When: a request is sent to list votes
        const response = await get(app, `${endpoint}/${workflowWithVotes.id}/votes`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: 200 OK and list of votes
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: GetWorkflowVotes200Response = response.body
        expect(body.votes).toHaveLength(1)
        expect(body.votes[0]).toMatchObject({
          voterId: orgMemberUser.user.id,
          voterType: "USER",
          voteType: "APPROVE",
          reason: "Looks good"
        })
        expect(body.votes[0]?.votedForGroups).toEqual([mockGroupId1])
      })

      it("should return empty list if no votes cast", async () => {
        // Given: a workflow with no votes
        const emptyWorkflow = await createMockWorkflowInDb(prisma, {
          name: "Empty-Workflow"
        })

        // When: listing votes
        const response = await get(app, `${endpoint}/${emptyWorkflow.id}/votes`).withToken(orgAdminUser.token).build()

        // Expect: 200 OK and empty list
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: GetWorkflowVotes200Response = response.body
        expect(body.votes).toHaveLength(0)
      })
    })

    describe("bad cases", () => {
      it("should return 404 NOT_FOUND (WORKFLOW_NOT_FOUND) when listing votes for non-existent workflow", async () => {
        // Given: a non-existent workflow ID
        const nonExistentId = randomUUID()

        // When: listing votes
        const response = await get(app, `${endpoint}/${nonExistentId}/votes`).withToken(orgAdminUser.token).build()

        // Expect: 404 Not Found
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("WORKFLOW_NOT_FOUND")
      })
    })
  })
})
