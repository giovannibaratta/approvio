import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {WORKFLOW_TEMPLATES_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient, WorkflowTemplate as PrismaWorkflowTemplate, Space as PrismaSpace} from "@prisma/client"
import {
  WorkflowTemplateCreate,
  WorkflowTemplateUpdate,
  WorkflowTemplate as WorkflowTemplateApi,
  ListWorkflowTemplates200Response
} from "@approvio/api"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase} from "../database"
import {
  createDomainMockUserInDb,
  createMockWorkflowTemplateInDb,
  MockConfigProvider,
  createMockSpaceInDb
} from "../shared/mock-data"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {ApprovalRuleType} from "@domain"
import {get, post, put} from "../shared/requests"
import {UserWithToken} from "../shared/types"
import "expect-more-jest"
import "@utils/matchers"
import {TokenPayloadBuilder} from "@services"

describe("Workflow Templates API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let jwtService: JwtService
  let testSpace: PrismaSpace

  const endpoint = `/${WORKFLOW_TEMPLATES_ENDPOINT_ROOT}`

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
    const configProvider = module.get(ConfigProvider)

    const adminUser = await createDomainMockUserInDb(prisma, {orgAdmin: true})
    const memberUser = await createDomainMockUserInDb(prisma, {orgAdmin: false})
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

    testSpace = await createMockSpaceInDb(prisma)

    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  describe("POST /workflow-templates", () => {
    let createWorkflowTemplatePayload: WorkflowTemplateCreate

    beforeEach(() => {
      createWorkflowTemplatePayload = {
        name: "Test Workflow Template",
        description: "A test workflow template",
        approvalRule: {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId: randomUUID(),
          minCount: 1
        },
        actions: [],
        defaultExpiresInHours: 24,
        spaceId: testSpace.id
      }
    })

    describe("good cases", () => {
      it("should create a workflow template and return 201 with location header (as OrgAdmin)", async () => {
        // When
        const response = await post(app, endpoint)
          .withToken(orgAdminUser.token)
          .build()
          .send(createWorkflowTemplatePayload)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.headers.location).toMatch(new RegExp(`${endpoint}/[a-f0-9-]+`))

        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""

        // Validate side effects in DB
        const templateDbObject = await prisma.workflowTemplate.findUnique({
          where: {id: responseUuid}
        })
        expect(templateDbObject).toBeDefined()
        expect(templateDbObject?.name).toEqual(createWorkflowTemplatePayload.name)
        expect(templateDbObject?.description).toEqual(createWorkflowTemplatePayload.description)
        expect(templateDbObject?.id).toEqual(responseUuid)
        expect(templateDbObject?.defaultExpiresInHours).toEqual(createWorkflowTemplatePayload.defaultExpiresInHours)
      })

      it("should create a workflow template without description and defaultExpiresInHours (as OrgAdmin)", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "Minimal Template",
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: randomUUID(),
            minCount: 1
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)

        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const templateDbObject = await prisma.workflowTemplate.findUnique({where: {id: responseUuid}})

        expect(templateDbObject?.description).toBeNull()
        expect(templateDbObject?.defaultExpiresInHours).toBeNull()
      })

      it("should create a workflow template with complex approval rule (as OrgAdmin)", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "Complex Rule Template",
          approvalRule: {
            type: ApprovalRuleType.AND,
            rules: [
              {
                type: ApprovalRuleType.GROUP_REQUIREMENT,
                groupId: randomUUID(),
                minCount: 2
              },
              {
                type: ApprovalRuleType.OR,
                rules: [
                  {
                    type: ApprovalRuleType.GROUP_REQUIREMENT,
                    groupId: randomUUID(),
                    minCount: 1
                  }
                ]
              }
            ]
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)

        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const templateDbObject = await prisma.workflowTemplate.findUnique({where: {id: responseUuid}})

        expect(templateDbObject?.approvalRule).toEqual(requestBody.approvalRule)
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When
        const response = await post(app, endpoint).build().send(createWorkflowTemplatePayload)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 409 CONFLICT (WORKFLOW_TEMPLATE_ALREADY_EXISTS) for duplicate name", async () => {
        // Given
        const existingName = "Duplicate Template"
        await createMockWorkflowTemplateInDb(prisma, {name: existingName})
        const requestBody: WorkflowTemplateCreate = {
          name: existingName,
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: randomUUID(),
            minCount: 1
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_ALREADY_EXISTS")
      })

      it("should return 400 BAD_REQUEST (WORKFLOW_TEMPLATE_NAME_EMPTY) for empty name", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "  ", // Whitespace only
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: randomUUID(),
            minCount: 1
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_NAME_EMPTY")
      })

      it("should return 400 BAD_REQUEST (WORKFLOW_TEMPLATE_NAME_TOO_LONG) for name exceeding max length", async () => {
        // Given
        const longName = "A".repeat(513) // Exceeds WORKFLOW_TEMPLATE_NAME_MAX_LENGTH (512)
        const requestBody: WorkflowTemplateCreate = {
          name: longName,
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: randomUUID(),
            minCount: 1
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_NAME_TOO_LONG")
      })

      it("should return 400 BAD_REQUEST (WORKFLOW_TEMPLATE_NAME_INVALID_CHARACTERS) for name with invalid characters", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "template@name!",
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: randomUUID(),
            minCount: 1
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_NAME_INVALID_CHARACTERS")
      })

      it("should return 400 BAD_REQUEST (WORKFLOW_TEMPLATE_DESCRIPTION_TOO_LONG) for description exceeding max length", async () => {
        // Given
        const longDescription = "A".repeat(2049) // Exceeds WORKFLOW_TEMPLATE_DESCRIPTION_MAX_LENGTH (2048)
        const requestBody: WorkflowTemplateCreate = {
          name: "Valid Template Name",
          description: longDescription,
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: randomUUID(),
            minCount: 1
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_DESCRIPTION_TOO_LONG")
      })

      it("should return 400 BAD_REQUEST (WORKFLOW_TEMPLATE_EXPIRES_IN_HOURS_INVALID) for invalid expires in hours", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "Invalid Expires Template",
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: randomUUID(),
            minCount: 1
          },
          defaultExpiresInHours: 0, // Invalid: must be >= 1
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_EXPIRES_IN_HOURS_INVALID")
      })

      it("should return 400 BAD_REQUEST (GROUP_RULE_INVALID_MIN_COUNT) for invalid min count in approval rule", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "Invalid MinCount Template",
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: randomUUID(),
            minCount: 0 // Invalid: minCount must be at least 1
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("APPROVAL_RULE_GROUP_RULE_INVALID_MIN_COUNT")
      })

      it("should return 400 BAD_REQUEST (GROUP_RULE_INVALID_GROUP_ID) for invalid group ID in approval rule", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "Invalid Group Rule Template",
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: "invalid-group-id", // Invalid: not a valid UUID
            minCount: 1
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("APPROVAL_RULE_GROUP_RULE_INVALID_GROUP_ID")
      })

      it("should return 400 BAD_REQUEST (AND_RULE_MUST_HAVE_RULES) for AND rule with empty rules array", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "Empty AND Rule Template",
          approvalRule: {
            type: ApprovalRuleType.AND,
            rules: [] // Invalid: AND rule must have at least one rule
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("APPROVAL_RULE_AND_RULE_MUST_HAVE_RULES")
      })

      it("should return 400 BAD_REQUEST (OR_RULE_MUST_HAVE_RULES) for OR rule with empty rules array", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "Empty OR Rule Template",
          approvalRule: {
            type: ApprovalRuleType.OR,
            rules: [] // Invalid: OR rule must have at least one rule
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("APPROVAL_RULE_OR_RULE_MUST_HAVE_RULES")
      })
    })
  })

  describe("GET /workflow-templates", () => {
    describe("good cases", () => {
      it("should return empty list when no templates exist", async () => {
        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflowTemplates200Response = response.body
        expect(body.data).toEqual([])
        expect(body.pagination.total).toEqual(0)
      })

      it("should return list of workflow templates with pagination", async () => {
        // Given
        const template1 = await createMockWorkflowTemplateInDb(prisma, {
          name: "Template 1",
          description: "Description 1"
        })
        const template2 = await createMockWorkflowTemplateInDb(prisma, {
          name: "Template 2",
          description: "Description 2"
        })

        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflowTemplates200Response = response.body
        expect(body.data).toHaveLength(2)
        expect(body.pagination.total).toEqual(2)
        expect(body.pagination.page).toEqual(1)
        expect(body.pagination.limit).toEqual(20)

        // Check that templates are returned (order might vary)
        const templateIds = body.data.map(t => t.id)
        expect(templateIds).toContain(template1.id)
        expect(templateIds).toContain(template2.id)
      })

      it("should support pagination parameters", async () => {
        // Given
        await createMockWorkflowTemplateInDb(prisma, {name: "Template 1"})
        await createMockWorkflowTemplateInDb(prisma, {name: "Template 2"})
        await createMockWorkflowTemplateInDb(prisma, {name: "Template 3"})

        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).query({page: 2, limit: 2}).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflowTemplates200Response = response.body
        expect(body.data).toHaveLength(1) // Third template
        expect(body.pagination.total).toEqual(3)
        expect(body.pagination.page).toEqual(2)
        expect(body.pagination.limit).toEqual(2)
      })

      it("should allow org members to list templates", async () => {
        // Given
        await createMockWorkflowTemplateInDb(prisma, {name: "Member Template"})

        // When
        const response = await get(app, endpoint).withToken(orgMemberUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflowTemplates200Response = response.body
        expect(body.data).toHaveLength(1)
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When
        const response = await get(app, endpoint).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })
    })
  })

  describe("GET /workflow-templates/:templateId", () => {
    let createdTemplate: PrismaWorkflowTemplate

    beforeEach(async () => {
      createdTemplate = await createMockWorkflowTemplateInDb(prisma, {
        name: "Get Template",
        description: "Template for get test"
      })
    })

    describe("good cases", () => {
      it("should return workflow template details when fetching by ID (as OrgAdmin)", async () => {
        // When
        const response = await get(app, `${endpoint}/${createdTemplate.id}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowTemplateApi = response.body
        expect(body.id).toEqual(createdTemplate.id)
        expect(body.name).toEqual(createdTemplate.name)
        expect(body.description).toEqual(createdTemplate.description)
        expect(body.createdAt).toBeDefined()
        expect(body.updatedAt).toBeDefined()
      })

      it("should return workflow template details (as OrgMember)", async () => {
        // When
        const response = await get(app, `${endpoint}/${createdTemplate.id}`).withToken(orgMemberUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowTemplateApi = response.body
        expect(body.id).toEqual(createdTemplate.id)
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When
        const response = await get(app, `${endpoint}/${createdTemplate.id}`).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 404 NOT_FOUND for non-existent template", async () => {
        // Given
        const nonExistentId = randomUUID()

        // When
        const response = await get(app, `${endpoint}/${nonExistentId}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_NOT_FOUND")
      })
    })
  })

  describe("PUT /workflow-templates/:templateId", () => {
    let createdTemplate: PrismaWorkflowTemplate

    beforeEach(async () => {
      createdTemplate = await createMockWorkflowTemplateInDb(prisma, {
        name: "Update Template",
        description: "Original description"
      })
    })

    const updatePayload: WorkflowTemplateUpdate = {
      description: "Updated description",
      defaultExpiresInHours: 48
    }

    describe("good cases", () => {
      it("should update workflow template and return updated data (as OrgAdmin)", async () => {
        // When
        const response = await put(app, `${endpoint}/${createdTemplate.name}`)
          .withToken(orgAdminUser.token)
          .build()
          .send(updatePayload)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowTemplateApi = response.body
        expect(body.id).not.toEqual(createdTemplate.id)
        expect(body.name).toEqual(createdTemplate.name) // Name should not change
        expect(body.description).toEqual(updatePayload.description)
        expect(body.defaultExpiresInHours).toEqual(updatePayload.defaultExpiresInHours)

        // Validate side effects in DB
        const originalTemplate = await prisma.workflowTemplate.findUnique({
          where: {id: createdTemplate.id}
        })
        expect(originalTemplate?.name).toEqual(createdTemplate.name) // Name should not change
        expect(originalTemplate?.description).toEqual(createdTemplate.description) // Original description should remain
        expect(originalTemplate?.status).toEqual("PENDING_DEPRECATION") // Original template should be deprecated
        expect(originalTemplate?.version).toEqual("1") // Original template should now have version 1

        const newTemplate = await prisma.workflowTemplate.findUnique({
          where: {id: body.id}
        })
        expect(newTemplate?.description).toEqual(updatePayload.description)
        expect(newTemplate?.defaultExpiresInHours).toEqual(updatePayload.defaultExpiresInHours)
        expect(newTemplate?.status).toEqual("ACTIVE") // New template should be active
        expect(newTemplate?.version).toEqual("latest") // New template should be latest
      })

      it("should update only provided fields", async () => {
        // Given
        const partialUpdate: WorkflowTemplateUpdate = {
          description: "Partially Updated Description"
        }

        // When
        const response = await put(app, `${endpoint}/${createdTemplate.name}`)
          .withToken(orgAdminUser.token)
          .build()
          .send(partialUpdate)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowTemplateApi = response.body
        expect(body.name).toEqual(createdTemplate.name) // Unchanged
        expect(body.description).toEqual(partialUpdate.description)
      })

      it("should create new version and deprecate old version on update", async () => {
        // Given
        const updatePayload: WorkflowTemplateUpdate = {
          description: "New version description"
        }

        // When
        const response = await put(app, `${endpoint}/${createdTemplate.name}`)
          .withToken(orgAdminUser.token)
          .build()
          .send(updatePayload)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowTemplateApi = response.body
        expect(body.id).not.toEqual(createdTemplate.id) // New template should have different ID
        expect(body.name).toEqual(createdTemplate.name) // Same name
        expect(body.description).toEqual(updatePayload.description)
        expect(body.version).toEqual("latest") // New version should be latest

        // Validate that both templates exist in DB
        const allTemplates = await prisma.workflowTemplate.findMany({
          where: {name: createdTemplate.name}
        })
        expect(allTemplates).toHaveLength(2)

        // Original template should be deprecated
        const originalTemplate = allTemplates.find(t => t.id === createdTemplate.id)
        expect(originalTemplate?.status).toEqual("PENDING_DEPRECATION")

        // New template should be active
        const newTemplate = allTemplates.find(t => t.id === body.id)
        expect(newTemplate?.status).toEqual("ACTIVE")
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When
        const response = await put(app, `${endpoint}/${createdTemplate.name}`).build().send(updatePayload)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 404 NOT_FOUND for non-existent template", async () => {
        // Given
        const nonExistentId = randomUUID()

        // When
        const response = await put(app, `${endpoint}/${nonExistentId}`)
          .withToken(orgAdminUser.token)
          .build()
          .send(updatePayload)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_NOT_FOUND")
      })

      it("should return 400 BAD_REQUEST (WORKFLOW_TEMPLATE_DESCRIPTION_TOO_LONG) for very long description in update", async () => {
        // Given
        const invalidUpdate: WorkflowTemplateUpdate = {
          description: "a".repeat(2049) // Too long
        }

        // When
        const response = await put(app, `${endpoint}/${createdTemplate.name}`)
          .withToken(orgAdminUser.token)
          .build()
          .send(invalidUpdate)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_DESCRIPTION_TOO_LONG")
      })
    })
  })
})
