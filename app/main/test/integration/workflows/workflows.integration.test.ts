import {
  ApprovalRule,
  CanVoteResponse as CanVoteResponseApi,
  GroupRequirementRule,
  Workflow as WorkflowApi,
  WorkflowCreate,
  WorkflowVoteRequest as WorkflowVoteRequestApi
} from "@approvio/api"
import {AppModule} from "@app/app.module"
import {WORKFLOWS_ENDPOINT_ROOT} from "@controllers"
import {
  ApprovalRuleType,
  HumanGroupMembershipRole,
  OrgRole,
  WORKFLOW_DESCRIPTION_MAX_LENGTH,
  WORKFLOW_NAME_MAX_LENGTH,
  WorkflowStatus
} from "@domain"
import {DatabaseClient} from "@external"
import {Config} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient, Workflow as PrismaWorkflow} from "@prisma/client"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "../database"
import {createDomainMockUserInDb} from "../shared/mock-data"
import {get, post} from "../shared/requests"
import {UserWithToken} from "../shared/types"

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

async function addUserToGroup(
  prisma: PrismaClient,
  groupId: string,
  userId: string,
  role: HumanGroupMembershipRole
): Promise<void> {
  await prisma.groupMembership.create({
    data: {
      groupId: groupId,
      userId: userId,
      role: role,
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
  let mockGroupId1: string
  let mockGroupId2: string

  const endpoint = `/${WORKFLOWS_ENDPOINT_ROOT}`

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
    const testGroup1 = await createTestGroup(prisma, "Test-Approver-Group-1")
    const testGroup2 = await createTestGroup(prisma, "Test-Approver-Group-2")

    orgAdminUser = {user: adminUser, token: jwtService.sign({email: adminUser.email, sub: adminUser.id})}
    orgMemberUser = {user: memberUser, token: jwtService.sign({email: memberUser.email, sub: memberUser.id})}
    mockGroupId1 = testGroup1.id
    mockGroupId2 = testGroup2.id

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

  // Helper function to create a workflow for tests
  async function createTestWorkflow(params: {
    name: string
    rule: ApprovalRule
    description?: string
    status?: WorkflowStatus
  }): Promise<PrismaWorkflow> {
    const workflow = await prisma.workflow.create({
      data: {
        id: randomUUID(),
        name: params.name,
        description: params.description,
        status: params.status ?? WorkflowStatus.APPROVED,
        rule: params.rule,
        recalculationRequired: false,
        occ: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    return workflow
  }

  describe("POST /workflows", () => {
    let defaultApprovalRule: GroupRequirementRule

    beforeEach(() => {
      defaultApprovalRule = {
        type: "GROUP_REQUIREMENT",
        groupId: mockGroupId1,
        minCount: 1
      }
    })

    describe("good cases", () => {
      it("should create a workflow and return 201 with location header (as OrgAdmin)", async () => {
        // Given: a workflow creation request
        const requestBody: WorkflowCreate = {
          name: "Test-Workflow-1",
          description: "A test description for workflow",
          approvalRule: defaultApprovalRule
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
          approvalRule: defaultApprovalRule
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 201 Created status and the workflow in DB should have a null description
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const workflowDbObject = await prisma.workflow.findUnique({where: {id: responseUuid}})
        expect(workflowDbObject?.description).toBeNull()
      })

      it("should create a workflow with an AND rule (as OrgAdmin)", async () => {
        // Given: a workflow creation request with an AND rule
        const andRule: ApprovalRule = {
          type: "AND",
          rules: [
            {type: "GROUP_REQUIREMENT", groupId: mockGroupId1, minCount: 1},
            {type: "GROUP_REQUIREMENT", groupId: mockGroupId2, minCount: 2}
          ]
        }
        const requestBody: WorkflowCreate = {
          name: "And-Rule-Workflow",
          approvalRule: andRule
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 201 Created status and the workflow in DB should be defined
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const workflowDbObject = await prisma.workflow.findUnique({where: {id: responseUuid}})
        expect(workflowDbObject).toBeDefined()
      })

      it("should create a workflow with an OR rule (as OrgAdmin)", async () => {
        // Given: a workflow creation request with an OR rule
        const orRule: ApprovalRule = {
          type: "OR",
          rules: [
            {type: "GROUP_REQUIREMENT", groupId: mockGroupId1, minCount: 1},
            {type: "GROUP_REQUIREMENT", groupId: mockGroupId2, minCount: 2}
          ]
        }
        const requestBody: WorkflowCreate = {
          name: "Or-Rule-Workflow",
          approvalRule: orRule
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 201 Created status and the workflow in DB should be defined
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const workflowDbObject = await prisma.workflow.findUnique({where: {id: responseUuid}})
        expect(workflowDbObject).toBeDefined()
      })

      it("should create a workflow with nested rules (depth 2) (as OrgAdmin)", async () => {
        // Given: a workflow creation request with nested rules
        const nestedRule: ApprovalRule = {
          type: "AND",
          rules: [
            {type: "GROUP_REQUIREMENT", groupId: mockGroupId1, minCount: 1},
            {
              type: "OR",
              rules: [{type: "GROUP_REQUIREMENT", groupId: mockGroupId2, minCount: 1}]
            }
          ]
        }
        const requestBody: WorkflowCreate = {
          name: "Nested-Rule-Workflow",
          approvalRule: nestedRule
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 201 Created status and the workflow in DB should be defined
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const workflowDbObject = await prisma.workflow.findUnique({where: {id: responseUuid}})
        expect(workflowDbObject).toBeDefined()
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // Given: a workflow creation request
        const requestBody: WorkflowCreate = {
          name: "Unauthorized-Workflow",
          approvalRule: defaultApprovalRule
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
          approvalRule: defaultApprovalRule
        }
        await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // When: another request is sent to create a workflow with the same name
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 409 Conflict status with WORKFLOW_ALREADY_EXISTS error code
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body).toHaveErrorCode("WORKFLOW_ALREADY_EXISTS")
      })

      it("should return 400 BAD_REQUEST (NAME_EMPTY) if name is empty (as OrgAdmin)", async () => {
        // Given: a workflow creation request with an empty name
        const requestBody: WorkflowCreate = {
          name: " ", // Whitespace only
          approvalRule: defaultApprovalRule
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with NAME_EMPTY error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("NAME_EMPTY")
      })

      it("should return 400 BAD_REQUEST (NAME_INVALID_CHARACTERS) if name has invalid characters (as OrgAdmin)", async () => {
        // Given: a workflow creation request with invalid characters in the name
        const requestBody: WorkflowCreate = {
          name: "Invalid Name!", // Contains '!'
          approvalRule: defaultApprovalRule
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with NAME_INVALID_CHARACTERS error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("NAME_INVALID_CHARACTERS")
      })

      it("should return 400 BAD_REQUEST (NAME_TOO_LONG) if name is too long (as OrgAdmin)", async () => {
        // Given: a workflow creation request with a name that is too long
        const requestBody: WorkflowCreate = {
          name: "a".repeat(WORKFLOW_NAME_MAX_LENGTH + 1),
          approvalRule: defaultApprovalRule
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with NAME_TOO_LONG error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("NAME_TOO_LONG")
      })

      it("should return 400 BAD_REQUEST (DESCRIPTION_TOO_LONG) if description is too long (as OrgAdmin)", async () => {
        // Given: a workflow creation request with a description that is too long
        const requestBody: WorkflowCreate = {
          name: "Workflow-Long-Desc",
          description: "a".repeat(WORKFLOW_DESCRIPTION_MAX_LENGTH + 1),
          approvalRule: defaultApprovalRule
        }

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with DESCRIPTION_TOO_LONG error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("DESCRIPTION_TOO_LONG")
      })

      it("should return 400 BAD_REQUEST (GROUP_RULE_INVALID_GROUP_ID) for invalid group ID in rule (as OrgAdmin)", async () => {
        // Given: a workflow creation request with an invalid group ID in the approval rule
        const invalidRule: ApprovalRule = {
          type: "GROUP_REQUIREMENT",
          groupId: "not-a-uuid",
          minCount: 1
        }
        const requestBody: WorkflowCreate = {name: "Invalid-Rule-Workflow", approvalRule: invalidRule}

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with GROUP_RULE_INVALID_GROUP_ID error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_RULE_INVALID_GROUP_ID")
      })

      it("should return 400 BAD_REQUEST (GROUP_RULE_INVALID_MIN_COUNT) for minCount < 1 in rule (as OrgAdmin)", async () => {
        // Given: a workflow creation request with minCount less than 1 in the approval rule
        const invalidRule: ApprovalRule = {
          type: "GROUP_REQUIREMENT",
          groupId: mockGroupId1,
          minCount: 0
        }
        const requestBody: WorkflowCreate = {name: "Invalid-MinCount-Workflow", approvalRule: invalidRule}

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with GROUP_RULE_INVALID_MIN_COUNT error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_RULE_INVALID_MIN_COUNT")
      })

      it("should return 400 BAD_REQUEST (AND_RULE_MUST_HAVE_RULES) for AND rule with empty rules array (as OrgAdmin)", async () => {
        // Given: a workflow creation request with an AND rule but an empty rules array
        const invalidRule: ApprovalRule = {type: "AND", rules: []}
        const requestBody: WorkflowCreate = {name: "Empty-And-Rule-Workflow", approvalRule: invalidRule}

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with AND_RULE_MUST_HAVE_RULES error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("AND_RULE_MUST_HAVE_RULES")
      })

      it("should return 400 BAD_REQUEST (MAX_RULE_NESTING_EXCEEDED) for rule nesting too deep (as OrgAdmin)", async () => {
        // Given: a workflow creation request with approval rules nested too deeply (assumes max depth is 2, so this is 3 levels)
        const deeplyNestedRule: ApprovalRule = {
          type: "AND",
          rules: [
            {
              type: "OR",
              rules: [
                {
                  type: "AND",
                  rules: [{type: "GROUP_REQUIREMENT", groupId: mockGroupId1, minCount: 1}]
                }
              ]
            }
          ]
        }
        const requestBody: WorkflowCreate = {name: "Deep-Nest-Workflow", approvalRule: deeplyNestedRule}

        // When: the request is sent with an OrgAdmin token
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect: a 400 Bad Request status with MAX_RULE_NESTING_EXCEEDED error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("MAX_RULE_NESTING_EXCEEDED")
      })
    })
  })

  describe("GET /workflows/:workflowIdentifier", () => {
    let testWorkflow: PrismaWorkflow
    let rule1: GroupRequirementRule

    beforeEach(async () => {
      rule1 = {type: "GROUP_REQUIREMENT", groupId: mockGroupId1, minCount: 1}
      testWorkflow = await createTestWorkflow({
        name: "Specific-Workflow",
        rule: rule1,
        description: "Details for specific workflow",
        status: WorkflowStatus.PENDING
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
        expect(body.approvalRule).toEqual(rule1)
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

  describe(`GET ${endpoint}/:workflowId/canVote`, () => {
    let testWorkflow: PrismaWorkflow
    let workflowRequiringGroup1: PrismaWorkflow
    let ruleForGroup1: GroupRequirementRule

    beforeEach(async () => {
      ruleForGroup1 = {
        type: ApprovalRuleType.GROUP_REQUIREMENT,
        groupId: mockGroupId1,
        minCount: 1
      }
      // Given: a workflow that requires a specific group for voting and a user added to that group
      workflowRequiringGroup1 = await createTestWorkflow({
        name: "Workflow-Group1-Req",
        rule: ruleForGroup1,
        description: "Workflow requiring group 1",
        status: WorkflowStatus.PENDING
      })
      await addUserToGroup(prisma, mockGroupId1, orgMemberUser.user.id, HumanGroupMembershipRole.APPROVER)

      // Given: a generic workflow for other tests (e.g., admin access)
      testWorkflow = await createTestWorkflow({
        name: "Generic-Workflow-For-CanVote",
        rule: ruleForGroup1
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
      })

      it("should return 200 OK with canVote:true for OrgAdmin if they are part of a group", async () => {
        // Given: OrgAdmin is added to the required group
        await addUserToGroup(prisma, mockGroupId1, orgAdminUser.user.id, HumanGroupMembershipRole.APPROVER)

        // When: a request is sent to check voting eligibility with an OrgAdmin token
        const response = await get(app, `${endpoint}/${workflowRequiringGroup1.id}/canVote`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: a 200 OK status with canVote set to true and VOTE_PENDING status
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: CanVoteResponseApi = response.body
        expect(body.canVote).toBe(true)
        expect(body.voteStatus).toEqual("VOTE_PENDING")
      })

      it("should return 200 OK with canVote:false if user is not in the required group", async () => {
        // Given: a new user not in any group related to this workflow
        const nonMemberUser = await createDomainMockUserInDb(prisma, {orgRole: OrgRole.MEMBER})
        const nonMemberToken = jwtService.sign({email: nonMemberUser.email, sub: nonMemberUser.id})

        // When: a request is sent to check voting eligibility with the non-member user's token
        const response = await get(app, `${endpoint}/${workflowRequiringGroup1.id}/canVote`)
          .withToken(nonMemberToken)
          .build()

        // Expect: a 200 OK status with canVote set to false
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: CanVoteResponseApi = response.body
        expect(body.canVote).toBe(false)
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
    let workflowForVoting: PrismaWorkflow
    let ruleForGroup1Voting: GroupRequirementRule

    beforeEach(async () => {
      ruleForGroup1Voting = {type: "GROUP_REQUIREMENT", groupId: mockGroupId1, minCount: 1}
      workflowForVoting = await createTestWorkflow({
        name: "Workflow-For-Actual-Voting",
        rule: ruleForGroup1Voting,
        description: "Voting Test",
        status: WorkflowStatus.PENDING
      })
      await addUserToGroup(prisma, mockGroupId1, orgMemberUser.user.id, HumanGroupMembershipRole.APPROVER)
      await addUserToGroup(prisma, mockGroupId1, orgAdminUser.user.id, HumanGroupMembershipRole.APPROVER)
    })

    describe("good cases", () => {
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
      }, 60000)
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
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`).build().send(requestBody)

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

      it("should return 400 BAD_REQUEST if user is not eligible to vote (e.g., not in group)", async () => {
        // Given: a new user not in any group related to this workflow and a vote request body
        const nonVoter = await createDomainMockUserInDb(prisma, {orgRole: OrgRole.MEMBER})
        const nonVoterToken = jwtService.sign({email: nonVoter.email, sub: nonVoter.id})
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId1]
          }
        }

        // When: the vote request is sent with the non-voter user's token
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(nonVoterToken)
          .build()
          .send(requestBody)

        // Expect: a 403 Forbidden status with USER_NOT_ELIGIBLE_TO_VOTE error code
        expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
        expect(response.body).toHaveErrorCode("USER_NOT_ELIGIBLE_TO_VOTE")
      })

      it("should return 400 BAD_REQUEST for invalid voteType", async () => {
        // Given: a request body with an invalid vote type
        const requestBody = {
          voteType: {
            type: "MAYBE_LATER"
          }
        }

        // When: the vote request is sent with a user who can normally vote
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(orgMemberUser.token)
          .build()
          .send(requestBody)

        // Expect: a 400 Bad Request status with INVALID_VOTE_TYPE error code
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("INVALID_VOTE_TYPE")
      })
    })
  })
})
