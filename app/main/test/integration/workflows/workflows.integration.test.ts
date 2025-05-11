import {ApprovalRule, GroupRequirementRule, Workflow as WorkflowApi, WorkflowCreate} from "@api"
import {AppModule} from "@app/app.module"
import {WORKFLOWS_ENDPOINT_ROOT} from "@controllers"
import {OrgRole, WORKFLOW_DESCRIPTION_MAX_LENGTH, WORKFLOW_NAME_MAX_LENGTH, WorkflowStatus} from "@domain"
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
  async function createTestWorkflow(
    name: string,
    rule: ApprovalRule,
    description?: string,
    status?: WorkflowStatus
  ): Promise<PrismaWorkflow> {
    const workflow = await prisma.workflow.create({
      data: {
        id: randomUUID(),
        name: name,
        description: description,
        status: status ?? WorkflowStatus.EVALUATION_IN_PROGRESS,
        rule: rule,
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
        // Given
        const requestBody: WorkflowCreate = {
          name: "Test-Workflow-1",
          description: "A test description for workflow",
          approvalRule: defaultApprovalRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.headers.location).toMatch(new RegExp(`${endpoint}/[a-f0-9-]+`))

        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""

        // Validate side effects
        const workflowDbObject = await prisma.workflow.findUnique({
          where: {id: responseUuid}
        })
        expect(workflowDbObject).toBeDefined()
        expect(workflowDbObject?.name).toEqual(requestBody.name)
        expect(workflowDbObject?.description).toEqual(requestBody.description)
        expect(workflowDbObject?.id).toEqual(responseUuid)
      })

      it("should create a workflow with null description if not provided (as OrgAdmin)", async () => {
        // Given
        const requestBody: WorkflowCreate = {
          name: "Minimal-Workflow",
          approvalRule: defaultApprovalRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const workflowDbObject = await prisma.workflow.findUnique({where: {id: responseUuid}})
        expect(workflowDbObject?.description).toBeNull()
      })

      it("should create a workflow with an AND rule (as OrgAdmin)", async () => {
        // Given
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

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const workflowDbObject = await prisma.workflow.findUnique({where: {id: responseUuid}})
        expect(workflowDbObject).toBeDefined()
      })

      it("should create a workflow with an OR rule (as OrgAdmin)", async () => {
        // Given
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

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const workflowDbObject = await prisma.workflow.findUnique({where: {id: responseUuid}})
        expect(workflowDbObject).toBeDefined()
      })

      it("should create a workflow with nested rules (depth 2) (as OrgAdmin)", async () => {
        // Given
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

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const workflowDbObject = await prisma.workflow.findUnique({where: {id: responseUuid}})
        expect(workflowDbObject).toBeDefined()
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // Given
        const requestBody: WorkflowCreate = {
          name: "Unauthorized-Workflow",
          approvalRule: defaultApprovalRule
        }

        // When
        const response = await post(app, endpoint).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 409 CONFLICT (WORKFLOW_ALREADY_EXISTS) if a workflow with the same name exists (as OrgAdmin)", async () => {
        // Given
        const requestBody: WorkflowCreate = {
          name: "Duplicate-Workflow-Name",
          approvalRule: defaultApprovalRule
        }
        // Create the first workflow
        await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // When: Try creating again with the same name
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body).toHaveErrorCode("WORKFLOW_ALREADY_EXISTS")
      })

      it("should return 400 BAD_REQUEST (NAME_EMPTY) if name is empty (as OrgAdmin)", async () => {
        // Given
        const requestBody: WorkflowCreate = {
          name: " ", // Whitespace only
          approvalRule: defaultApprovalRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("NAME_EMPTY")
      })

      it("should return 400 BAD_REQUEST (NAME_INVALID_CHARACTERS) if name has invalid characters (as OrgAdmin)", async () => {
        // Given
        const requestBody: WorkflowCreate = {
          name: "Invalid Name!", // Contains '!'
          approvalRule: defaultApprovalRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("NAME_INVALID_CHARACTERS")
      })

      it("should return 400 BAD_REQUEST (NAME_TOO_LONG) if name is too long (as OrgAdmin)", async () => {
        // Given
        const requestBody: WorkflowCreate = {
          name: "a".repeat(WORKFLOW_NAME_MAX_LENGTH + 1),
          approvalRule: defaultApprovalRule
        }
        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)
        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("NAME_TOO_LONG")
      })

      it("should return 400 BAD_REQUEST (DESCRIPTION_TOO_LONG) if description is too long (as OrgAdmin)", async () => {
        // Given
        const requestBody: WorkflowCreate = {
          name: "Workflow-Long-Desc",
          description: "a".repeat(WORKFLOW_DESCRIPTION_MAX_LENGTH + 1),
          approvalRule: defaultApprovalRule
        }
        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)
        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("DESCRIPTION_TOO_LONG")
      })

      it("should return 400 BAD_REQUEST (GROUP_RULE_INVALID_GROUP_ID) for invalid group ID in rule (as OrgAdmin)", async () => {
        // Given
        const invalidRule: ApprovalRule = {
          type: "GROUP_REQUIREMENT",
          groupId: "not-a-uuid",
          minCount: 1
        }
        const requestBody: WorkflowCreate = {name: "Invalid-Rule-Workflow", approvalRule: invalidRule}
        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)
        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_RULE_INVALID_GROUP_ID")
      })

      it("should return 400 BAD_REQUEST (GROUP_RULE_INVALID_MIN_COUNT) for minCount < 1 in rule (as OrgAdmin)", async () => {
        // Given
        const invalidRule: ApprovalRule = {
          type: "GROUP_REQUIREMENT",
          groupId: mockGroupId1,
          minCount: 0
        }
        const requestBody: WorkflowCreate = {name: "Invalid-MinCount-Workflow", approvalRule: invalidRule}
        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)
        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_RULE_INVALID_MIN_COUNT")
      })

      it("should return 400 BAD_REQUEST (AND_RULE_MUST_HAVE_RULES) for AND rule with empty rules array (as OrgAdmin)", async () => {
        // Given
        const invalidRule: ApprovalRule = {type: "AND", rules: []}
        const requestBody: WorkflowCreate = {name: "Empty-And-Rule-Workflow", approvalRule: invalidRule}
        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)
        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("AND_RULE_MUST_HAVE_RULES")
      })

      it("should return 400 BAD_REQUEST (MAX_RULE_NESTING_EXCEEDED) for rule nesting too deep (as OrgAdmin)", async () => {
        // Given
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
        } // Assumes max depth is 2, so this is 3 levels
        const requestBody: WorkflowCreate = {name: "Deep-Nest-Workflow", approvalRule: deeplyNestedRule}

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("MAX_RULE_NESTING_EXCEEDED")
      })
    })
  })

  describe(`GET ${endpoint}/:workflowIdentifier`, () => {
    let testWorkflow: PrismaWorkflow
    let rule1: GroupRequirementRule

    beforeEach(async () => {
      rule1 = {type: "GROUP_REQUIREMENT", groupId: mockGroupId1, minCount: 1}
      testWorkflow = await createTestWorkflow("Specific-Workflow", rule1, "Details for specific workflow")
    })

    describe("good cases", () => {
      it("should return workflow details when fetching by ID (as OrgAdmin)", async () => {
        // When
        const response = await get(app, `${endpoint}/${testWorkflow.id}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowApi = response.body
        expect(body.id).toEqual(testWorkflow.id)
        expect(body.name).toEqual(testWorkflow.name)
        expect(body.description).toEqual(testWorkflow.description)
        expect(body.status).toEqual(testWorkflow.status) // Default ACTIVE
        expect(body.approvalRule).toEqual(rule1)
        expect(body.createdAt).toBeDefined()
        expect(body.updatedAt).toBeDefined()
      })

      it("should return workflow details when fetching by name (as OrgAdmin)", async () => {
        // When
        const response = await get(app, `${endpoint}/${testWorkflow.name}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowApi = response.body
        expect(body.id).toEqual(testWorkflow.id)
        expect(body.name).toEqual(testWorkflow.name)
      })

      it("should return workflow details if OrgMember (assuming OrgMembers can view workflows)", async () => {
        // When
        const response = await get(app, `${endpoint}/${testWorkflow.id}`).withToken(orgMemberUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowApi = response.body
        expect(body.id).toEqual(testWorkflow.id)
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        const response = await get(app, `${endpoint}/${testWorkflow.id}`).build()
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 404 NOT_FOUND (WORKFLOW_NOT_FOUND) when fetching non-existent ID (as OrgAdmin)", async () => {
        // Given
        const nonExistentId = randomUUID()
        // When
        const response = await get(app, `${endpoint}/${nonExistentId}`).withToken(orgAdminUser.token).build()
        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("WORKFLOW_NOT_FOUND")
      })

      it("should return 404 NOT_FOUND (WORKFLOW_NOT_FOUND) when fetching non-existent name (as OrgAdmin)", async () => {
        // Given
        const nonExistentName = "non-existent-workflow-name-abc"
        // When
        const response = await get(app, `${endpoint}/${nonExistentName}`).withToken(orgAdminUser.token).build()
        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("WORKFLOW_NOT_FOUND")
      })
    })
  })
})
