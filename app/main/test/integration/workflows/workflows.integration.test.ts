import {ApprovalRule, GroupRequirementRule, WorkflowCreate} from "@api"
import {AppModule} from "@app/app.module"
import {WORKFLOWS_ENDPOINT_ROOT} from "@controllers"
import {OrgRole, WORKFLOW_DESCRIPTION_MAX_LENGTH, WORKFLOW_NAME_MAX_LENGTH} from "@domain"
import {DatabaseClient} from "@external"
import {Config} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, prepareDatabase} from "../database"
import {createDomainMockUserInDb} from "../shared/mock-data"
import {post} from "../shared/requests"
import {UserWithToken} from "../shared/types"
import {randomUUID} from "crypto"

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
    const testGroup1 = await createTestGroup(prisma, "Test-Approver-Group-1")
    const testGroup2 = await createTestGroup(prisma, "Test-Approver-Group-2")

    orgAdminUser = {user: adminUser, token: jwtService.sign({email: adminUser.email, sub: adminUser.id})}
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
        const longName = "a".repeat(WORKFLOW_NAME_MAX_LENGTH + 1)
        const requestBody: WorkflowCreate = {
          name: longName,
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
        const longDescription = "a".repeat(WORKFLOW_DESCRIPTION_MAX_LENGTH + 1)
        const requestBody: WorkflowCreate = {
          name: "Long-Desc-Workflow",
          description: longDescription,
          approvalRule: defaultApprovalRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("DESCRIPTION_TOO_LONG")
      })

      it("should return 400 BAD_REQUEST (RULE_INVALID - GROUP_RULE_INVALID_MIN_COUNT) if approvalRule minCount is invalid (as OrgAdmin)", async () => {
        // Given
        const invalidRule: ApprovalRule = {
          type: "GROUP_REQUIREMENT",
          groupId: mockGroupId1,
          minCount: 0 // Must be >= 1
        }
        const requestBody: WorkflowCreate = {
          name: "Invalid-Rule-Workflow",
          approvalRule: invalidRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_RULE_INVALID_MIN_COUNT")
      })

      it("should return 400 BAD_REQUEST (RULE_INVALID - GROUP_RULE_INVALID_GROUP_ID) if approvalRule groupId is invalid (as OrgAdmin)", async () => {
        // Given
        const invalidRule: ApprovalRule = {
          type: "GROUP_REQUIREMENT",
          groupId: "not-a-valid-uuid",
          minCount: 1
        }
        const requestBody: WorkflowCreate = {
          name: "Invalid-Group-ID-Workflow",
          approvalRule: invalidRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("GROUP_RULE_INVALID_GROUP_ID")
      })

      it("should return 400 BAD_REQUEST (AND_RULE_MUST_HAVE_RULES) if AND rule has empty rules array (as OrgAdmin)", async () => {
        // Given
        const invalidRule: ApprovalRule = {
          type: "AND",
          rules: [] // Empty rules
        }
        const requestBody: WorkflowCreate = {
          name: "Empty-And-Rule-Workflow",
          approvalRule: invalidRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("AND_RULE_MUST_HAVE_RULES")
      })

      it("should return 400 BAD_REQUEST (OR_RULE_MUST_HAVE_RULES) if OR rule has empty rules array (as OrgAdmin)", async () => {
        // Given
        const invalidRule: ApprovalRule = {
          type: "OR",
          rules: [] // Empty rules
        }
        const requestBody: WorkflowCreate = {
          name: "Empty-Or-Rule-Workflow",
          approvalRule: invalidRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("OR_RULE_MUST_HAVE_RULES")
      })

      it("should return 400 BAD_REQUEST (MAX_RULE_NESTING_EXCEEDED) if rule nesting exceeds maximum depth (as OrgAdmin)", async () => {
        // Given
        const tooDeepRule: ApprovalRule = {
          // Depth 0
          type: "AND",
          rules: [
            {
              // Depth 1
              type: "OR",
              rules: [
                {
                  // Depth 2 -> Exceeds MAX_NESTING_DEPTH = 2
                  type: "AND",
                  rules: [
                    {
                      type: "GROUP_REQUIREMENT",
                      groupId: mockGroupId1,
                      minCount: 1
                    }
                  ]
                }
              ]
            }
          ]
        }
        const requestBody: WorkflowCreate = {
          name: "Too-Deep-Rule-Workflow",
          approvalRule: tooDeepRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("MAX_RULE_NESTING_EXCEEDED")
      })

      it("should return 400 BAD_REQUEST (INVALID_RULE_TYPE) if rule type is invalid (as OrgAdmin)", async () => {
        // Given
        const invalidRule = {
          type: "INVALID_TYPE", // Not AND, OR, or GROUP_REQUIREMENT
          groupId: mockGroupId1,
          minCount: 1
        } as unknown as ApprovalRule // Cast to bypass TS type checking for the test
        const requestBody: WorkflowCreate = {
          name: "Invalid-Type-Workflow",
          approvalRule: invalidRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("INVALID_RULE_TYPE")
      })

      it("should return 400 BAD_REQUEST (GROUP_RULE_INVALID_MIN_COUNT) if nested rule is invalid (as OrgAdmin)", async () => {
        // Given
        const nestedInvalidRule: ApprovalRule = {
          type: "AND",
          rules: [
            {type: "GROUP_REQUIREMENT", groupId: mockGroupId1, minCount: 1},
            {type: "GROUP_REQUIREMENT", groupId: mockGroupId2, minCount: 0} // Invalid minCount
          ]
        }
        const requestBody: WorkflowCreate = {
          name: "Nested-Invalid-Rule-Workflow",
          approvalRule: nestedInvalidRule
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        // The error code from the nested validation bubbles up
        expect(response.body).toHaveErrorCode("GROUP_RULE_INVALID_MIN_COUNT")
      })
    })
  })
})
