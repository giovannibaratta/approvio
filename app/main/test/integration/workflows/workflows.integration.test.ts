import {
  CanVoteResponse as CanVoteResponseApi,
  Workflow as WorkflowApi,
  WorkflowCreate,
  WorkflowVoteRequest as WorkflowVoteRequestApi,
  ListWorkflows200Response
} from "@approvio/api"
import {AppModule} from "@app/app.module"
import {WORKFLOWS_ENDPOINT_ROOT} from "@controllers"
import {RoleFactory} from "@domain"
import {ApprovalRuleType, WORKFLOW_DESCRIPTION_MAX_LENGTH, WORKFLOW_NAME_MAX_LENGTH, WorkflowStatus} from "@domain"
import {DatabaseClient} from "@external"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient, Workflow as PrismaWorkflow, WorkflowTemplate as PrismaWorkflowTemplate} from "@prisma/client"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "../database"
import {
  createDomainMockUserInDb,
  createMockWorkflowInDb,
  createMockWorkflowTemplateInDb,
  MockConfigProvider
} from "../shared/mock-data"
import {get, post} from "../shared/requests"
import {UserWithToken} from "../shared/types"
import {TokenPayloadBuilder} from "@services"

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

describe("Workflows API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let mockGroupId1: string
  let mockWorkflowTemplate: PrismaWorkflowTemplate

  const endpoint = `/${WORKFLOWS_ENDPOINT_ROOT}`

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

    const adminUser = await createDomainMockUserInDb(prisma, {orgAdmin: true})
    const memberUser = await createDomainMockUserInDb(prisma, {orgAdmin: false})
    const testGroup1 = await createTestGroup(prisma, "Test-Approver-Group-1")

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

    mockWorkflowTemplate = await createMockWorkflowTemplateInDb(prisma, {
      approvalRule: {
        type: ApprovalRuleType.GROUP_REQUIREMENT,
        groupId: mockGroupId1,
        minCount: 1
      }
    })

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
      const voterRole = RoleFactory.createWorkflowTemplateVoterRole({
        type: "workflow_template",
        workflowTemplateId: template.id
      })
      const roleForDb = JSON.parse(JSON.stringify(voterRole))

      await prisma.user.update({
        where: {id: orgMemberUser.user.id},
        data: {roles: [roleForDb]}
      })
      await prisma.user.update({
        where: {id: orgAdminUser.user.id},
        data: {roles: [roleForDb]}
      })

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
        expect(body.cantVoteReason).toBeUndefined()
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
        const voterRole = RoleFactory.createWorkflowTemplateVoterRole({
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
        const voterRole = RoleFactory.createWorkflowTemplateVoterRole({
          type: "workflow_template",
          workflowTemplateId: workflowTemplate.id
        })

        // Convert role to JSON-serializable format
        const roleForDb = JSON.parse(JSON.stringify(voterRole))

        // Update users with voter roles
        await prisma.user.update({
          where: {id: orgMemberUser.user.id},
          data: {roles: [roleForDb]}
        })
        await prisma.user.update({
          where: {id: orgAdminUser.user.id},
          data: {roles: [roleForDb]}
        })
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
        const voterRole = RoleFactory.createWorkflowTemplateVoterRole({
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
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When: a request is sent without a token
        const response = await get(app, endpoint).build()

        // Expect: a 401 Unauthorized status
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })
    })
  })
})
