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

import {cleanDatabase, prepareDatabase} from "@test/database"
import {
  createDomainMockUserInDb,
  createMockWorkflowTemplateInDb,
  MockConfigProvider,
  createMockSpaceInDb
} from "@test/mock-data"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {ApprovalRuleType} from "@domain"
import {get, post, put} from "@test/requests"
import {UserWithToken} from "@test/types"
import "expect-more-jest"
import "@utils/matchers"
import {TokenPayloadBuilder} from "@services"
import {v7 as uuidv7} from "uuid"

/**
 * Type guard assertion that checks if the value is a non-empty array of records.
 * Uses TypeScript's assertion signature to narrow the type without returning a value.
 * @throws Error (via Jest) if the assertions fail
 */
function assertIsNonEmptyArrayOfRecord(value: unknown): asserts value is Record<string, unknown>[] {
  expect(value).toBeDefined()
  expect(Array.isArray(value)).toBe(true)
  expect(value).toHaveLength(1)
}

/**
 * Type guard assertion that checks if the first element of an array is defined.
 * Uses TypeScript's assertion signature to narrow the array's element type.
 * @throws Error (via Jest) if the assertion fails
 */
function assertFirstActionIsDefined(
  actions: Record<string, unknown>[]
): asserts actions is [Record<string, unknown>, ...Record<string, unknown>[]] {
  expect(actions[0]).toBeDefined()
}

describe("Workflow Templates API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken
  let jwtService: JwtService
  let testSpace: PrismaSpace
  let configProvider: ConfigProvider

  const endpoint = `/${WORKFLOW_TEMPLATES_ENDPOINT_ROOT}`

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
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  describe("POST /workflow-templates", () => {
    let createWorkflowTemplatePayload: WorkflowTemplateCreate

    beforeEach(() => {
      createWorkflowTemplatePayload = {
        name: "Test Workflow Template",
        description: "A test workflow template",
        approvalRule: {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId: uuidv7(),
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

      it("should create a workflow template with high privilege requirement (as OrgAdmin)", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "High Privilege Template",
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: uuidv7(),
            minCount: 1,
            requireHighPrivilege: true
          },
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)

        expect(response.body).toMatchObject({
          approvalRule: {
            requireHighPrivilege: true
          }
        })
      })

      it("should create a workflow template without description and defaultExpiresInHours (as OrgAdmin)", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "Minimal Template",
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: uuidv7(),
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
                groupId: uuidv7(),
                minCount: 2
              },
              {
                type: ApprovalRuleType.OR,
                rules: [
                  {
                    type: ApprovalRuleType.GROUP_REQUIREMENT,
                    groupId: uuidv7(),
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
      it("should create a workflow template with webhook action (as OrgAdmin)", async () => {
        // Given
        const requestBody: WorkflowTemplateCreate = {
          name: "Webhook Template",
          approvalRule: {
            type: ApprovalRuleType.GROUP_REQUIREMENT,
            groupId: uuidv7(),
            minCount: 1
          },
          actions: [
            {
              type: "WEBHOOK",
              url: "https://example.com/webhook",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Custom-Header": "value"
              }
            }
          ],
          spaceId: testSpace.id
        }

        // When
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.CREATED)

        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""
        const templateDbObject = await prisma.workflowTemplate.findUnique({where: {id: responseUuid}})

        assertIsNonEmptyArrayOfRecord(templateDbObject?.actions)
        assertFirstActionIsDefined(templateDbObject.actions)
        const firstAction = templateDbObject.actions[0]

        expect(firstAction.type).toEqual("WEBHOOK")
        expect(firstAction.url).toEqual("https://example.com/webhook")
        expect(firstAction.method).toEqual("POST")
        expect(firstAction.headers).toEqual({
          "Content-Type": "application/json",
          "X-Custom-Header": "value"
        })
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
            groupId: uuidv7(),
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
            groupId: uuidv7(),
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
            groupId: uuidv7(),
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
            groupId: uuidv7(),
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
            groupId: uuidv7(),
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
            groupId: uuidv7(),
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
            groupId: uuidv7(),
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

    it("should return 400 BAD_REQUEST (WORKFLOW_ACTION_URL_INVALID) for invalid webhook URL", async () => {
      // Given
      const requestBody: WorkflowTemplateCreate = {
        name: "Invalid Webhook URL Template",
        approvalRule: {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId: uuidv7(),
          minCount: 1
        },
        actions: [
          {
            type: "WEBHOOK",
            url: "not-a-url",
            method: "POST"
          }
        ],
        spaceId: testSpace.id
      }

      // When
      const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      expect(response.body).toHaveErrorCode("WORKFLOW_ACTION_URL_INVALID")
    })

    it("should return 400 BAD_REQUEST (WORKFLOW_ACTION_MISSING_HTTP_METHOD) for missing webhook method", async () => {
      // Given
      const requestBody: WorkflowTemplateCreate = {
        name: "Missing Method Template",
        approvalRule: {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId: uuidv7(),
          minCount: 1
        },
        actions: [
          {
            type: "WEBHOOK",
            url: "https://example.com"
            // method missing
          }
        ],
        spaceId: testSpace.id
      }

      // When
      const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      expect(response.body).toHaveErrorCode("WORKFLOW_ACTION_MISSING_HTTP_METHOD")
    })

    it("should return 400 BAD_REQUEST (WORKFLOW_ACTION_HEADERS_INVALID) for invalid headers", async () => {
      // Given
      const requestBody: WorkflowTemplateCreate = {
        name: "Invalid Headers Template",
        approvalRule: {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId: uuidv7(),
          minCount: 1
        },
        actions: [
          {
            type: "WEBHOOK",
            url: "https://example.com",
            method: "POST",
            headers: {
              "Content-Type": 123 as unknown as string
            }
          }
        ],
        spaceId: testSpace.id
      }

      // When
      const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

      // Expect
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      expect(response.body).toHaveErrorCode("WORKFLOW_ACTION_HEADERS_INVALID")
    })
  })

  describe("GET /workflow-templates", () => {
    describe("good cases", () => {
      it("should filter workflow templates by space UUID", async () => {
        const space = await createMockSpaceInDb(prisma, {name: "Space-Test-Filter-UUID"})
        await createMockWorkflowTemplateInDb(prisma, {name: "Template-In-Space-1", spaceId: space.id})
        await createMockWorkflowTemplateInDb(prisma, {name: "Template-In-Other-Space"})

        const response = await get(app, `${endpoint}?spaceIdentifier=${space.id}`).withToken(orgAdminUser.token).build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflowTemplates200Response = response.body
        expect(body.data).toHaveLength(1)
        expect(body.data[0]?.name).toEqual("Template-In-Space-1")
      })

      it("should filter workflow templates by space name", async () => {
        const space = await createMockSpaceInDb(prisma, {name: "Space-Test-Filter-Name"})
        await createMockWorkflowTemplateInDb(prisma, {name: "Template-In-Space-Name", spaceId: space.id})

        const response = await get(app, `${endpoint}?spaceIdentifier=${space.name}`)
          .withToken(orgAdminUser.token)
          .build()

        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflowTemplates200Response = response.body
        expect(body.data).toHaveLength(1)
        expect(body.data[0]?.name).toEqual("Template-In-Space-Name")
      })

      it("should return empty list when no templates exist", async () => {
        // When
        const response = await get(app, endpoint).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflowTemplates200Response = response.body
        expect(body.data).toEqual([])
        expect(body.pagination.total).toEqual(0)
      })

      it("should perform a fuzzy search by name and ignore SQL injection attempts", async () => {
        // Given
        await createMockWorkflowTemplateInDb(prisma, {name: "Template 1"})
        await createMockWorkflowTemplateInDb(prisma, {name: "Template 2"})
        const targetTemplate = await createMockWorkflowTemplateInDb(prisma, {name: "fuzzy-template-target"})

        // When: We try a search that might look like SQL injection
        const responseInjection = await get(app, `${endpoint}?search=' OR 1=1 --`).withToken(orgAdminUser.token).build()

        // Expect: Should return empty results (safe from injection)
        expect(responseInjection).toHaveStatusCode(HttpStatus.OK)
        expect((responseInjection.body as ListWorkflowTemplates200Response).data).toHaveLength(0)

        // When: We do a normal fuzzy search
        const responseValid = await get(app, `${endpoint}?search=template-target`).withToken(orgAdminUser.token).build()

        // Expect: Should find the exact group (case insensitive partial match)
        expect(responseValid).toHaveStatusCode(HttpStatus.OK)
        expect((responseValid.body as ListWorkflowTemplates200Response).data).toHaveLength(1)
        expect((responseValid.body as ListWorkflowTemplates200Response).data[0]?.id).toEqual(targetTemplate.id)
      })

      it("should support EXACT searchMode", async () => {
        // Given
        await createMockWorkflowTemplateInDb(prisma, {name: "Template 123"})
        const targetTemplate = await createMockWorkflowTemplateInDb(prisma, {name: "Template 12"})

        // When: searching with searchMode=EXACT
        const response = await get(app, `${endpoint}?search=Template 12&searchMode=EXACT`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: Only the exact match should be returned
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflowTemplates200Response = response.body
        expect(body.data).toHaveLength(1)
        expect(body.data[0]?.id).toEqual(targetTemplate.id)
      })

      it("should return empty list when no templates match the exact search term", async () => {
        // Given
        await createMockWorkflowTemplateInDb(prisma, {name: "Template 123"})

        // When: searching with an incomplete term and searchMode=EXACT
        const response = await get(app, `${endpoint}?search=Template 12&searchMode=EXACT`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: No templates should be returned
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflowTemplates200Response = response.body
        expect(body.data).toHaveLength(0)
      })

      it("should support CONTAINS searchMode", async () => {
        // Given
        const template1 = await createMockWorkflowTemplateInDb(prisma, {name: "Template XYZ"})
        const template2 = await createMockWorkflowTemplateInDb(prisma, {name: "My Template XYZ 123"})
        await createMockWorkflowTemplateInDb(prisma, {name: "Template 123"})

        // When: searching with searchMode=CONTAINS
        const response = await get(app, `${endpoint}?search=Template XYZ&searchMode=CONTAINS`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect: Both templates containing the term should be returned
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: ListWorkflowTemplates200Response = response.body
        expect(body.data).toHaveLength(2)
        const returnedIds = body.data.map(t => t.id)
        expect(returnedIds).toContain(template1.id)
        expect(returnedIds).toContain(template2.id)
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

      describe("status filtering", () => {
        let active1: PrismaWorkflowTemplate
        let active2: PrismaWorkflowTemplate
        let deprecated: PrismaWorkflowTemplate
        let pendingDeprecation: PrismaWorkflowTemplate

        beforeEach(async () => {
          // Create templates with different statuses
          active1 = await createMockWorkflowTemplateInDb(prisma, {
            name: "Active 1",
            status: "ACTIVE"
          })
          active2 = await createMockWorkflowTemplateInDb(prisma, {
            name: "Active 2",
            status: "ACTIVE"
          })
          pendingDeprecation = await createMockWorkflowTemplateInDb(prisma, {
            name: "Pending Deprecation 1",
            status: "PENDING_DEPRECATION"
          })
          deprecated = await createMockWorkflowTemplateInDb(prisma, {
            name: "Deprecated 1",
            status: "DEPRECATED"
          })
        })

        it("should return only ACTIVE templates by default", async () => {
          // When
          const response = await get(app, endpoint).withToken(orgAdminUser.token).build()

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          const body: ListWorkflowTemplates200Response = response.body
          expect(body.data).toHaveLength(2)

          const ids = body.data.map(template => template.id)

          expect(ids).toBeArrayIncludingAllOf([active1.id, active2.id])
        })

        it("should filter by single status (DEPRECATED)", async () => {
          // When
          const response = await get(app, `${endpoint}?status=DEPRECATED`).withToken(orgAdminUser.token).build()

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          const body: ListWorkflowTemplates200Response = response.body
          expect(body.data).toHaveLength(1)
          expect(body.data[0]?.id).toEqual(deprecated.id)
        })

        it("should filter by multiple statuses", async () => {
          // When
          const response = await get(app, endpoint)
            .withToken(orgAdminUser.token)
            .query({status: ["PENDING_DEPRECATION", "DEPRECATED"]})
            .build()

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          const body: ListWorkflowTemplates200Response = response.body
          expect(body.data).toHaveLength(2)

          const ids = body.data.map(template => template.id)

          expect(ids).toBeArrayIncludingAllOf([deprecated.id, pendingDeprecation.id])
        })

        it("should return empty list when no templates match the status", async () => {
          // When
          const space = await createMockSpaceInDb(prisma)
          await createMockWorkflowTemplateInDb(prisma, {name: "Active in Space", status: "ACTIVE", spaceId: space.id})

          const response = await get(app, `${endpoint}?status=DEPRECATED&spaceIdentifier=${space.id}`)
            .withToken(orgAdminUser.token)
            .build()

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          const body: ListWorkflowTemplates200Response = response.body
          expect(body.data).toHaveLength(0)
        })
      })

      describe("sorting", () => {
        it("should support multiple field sorting with default ASC direction for missing directions", async () => {
          // Given
          const t1a = await createMockWorkflowTemplateInDb(prisma, {
            name: "Template A",
            createdAt: new Date("2023-01-02"),
            version: 1
          })
          const t1b = await createMockWorkflowTemplateInDb(prisma, {
            name: "Template B",
            createdAt: new Date("2023-01-01"),
            version: 1
          })
          const t2 = await createMockWorkflowTemplateInDb(prisma, {
            name: "Template B",
            createdAt: new Date("2023-01-03"),
            version: 2
          })

          // When: Sort by Version ASC, then CreatedAt (default ASC)
          // (Template A, 2023-01-01) -> (Template A, 2023-01-02) -> (Template B, 2023-01-03)
          const responseArr = await get(app, endpoint)
            .withToken(orgAdminUser.token)
            .query({sortBy: ["VERSION", "CREATED_AT"], sortDirection: ["ASC"]})
            .build()

          // Expect
          expect(responseArr).toHaveStatusCode(HttpStatus.OK)
          const bodyArr: ListWorkflowTemplates200Response = responseArr.body
          expect(bodyArr.data).toHaveLength(3)
          expect(bodyArr.data[0]?.id).toEqual(t1b.id)
          expect(bodyArr.data[1]?.id).toEqual(t1a.id)
          expect(bodyArr.data[2]?.id).toEqual(t2.id)

          // When: Sort by Version DESC, then CreatedAt ASC
          // (Template B, 2023-01-03) -> (Template A, 2023-01-01) -> (Template A, 2023-01-02)
          const responseSingle = await get(app, endpoint)
            .withToken(orgAdminUser.token)
            .query({sortBy: ["VERSION", "CREATED_AT"], sortDirection: ["DESC"]})
            .build()

          expect(responseSingle).toHaveStatusCode(HttpStatus.OK)
          const bodySingle: ListWorkflowTemplates200Response = responseSingle.body
          expect(bodySingle.data).toHaveLength(3)
          expect(bodySingle.data[0]?.id).toEqual(t2.id)
          expect(bodySingle.data[1]?.id).toEqual(t1b.id)
          expect(bodySingle.data[2]?.id).toEqual(t1a.id)
        })

        it("should support multiple field sorting with explicit directions", async () => {
          // Given
          const t1a = await createMockWorkflowTemplateInDb(prisma, {
            name: "Template A",
            createdAt: new Date("2023-01-01"),
            version: 1
          })
          const t2b = await createMockWorkflowTemplateInDb(prisma, {
            name: "Template B",
            createdAt: new Date("2023-01-02"),
            version: 1
          })
          const t2a = await createMockWorkflowTemplateInDb(prisma, {
            name: "Template A",
            createdAt: new Date("2023-01-02"),
            version: 2
          })

          // When: Sort by Version ASC, then CreatedAt DESC
          // Template A (newer) -> Template A (older)
          const response = await get(app, endpoint)
            .withToken(orgAdminUser.token)
            .query({sortBy: ["VERSION", "CREATED_AT"], sortDirection: ["ASC", "DESC"]})
            .build()

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.OK)
          const body: ListWorkflowTemplates200Response = response.body
          expect(body.data).toHaveLength(3)
          expect(body.data[0]?.id).toEqual(t2b.id)
          expect(body.data[1]?.id).toEqual(t1a.id)
          expect(body.data[2]?.id).toEqual(t2a.id)
        })
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
      it("should return 400 BAD_REQUEST (SORT_DIRECTION_LENGTH_MISMATCH) when more directions than fields provided", async () => {
        // When
        const response = await get(app, endpoint)
          .withToken(orgAdminUser.token)
          .query({sortBy: ["VERSION"], sortDirection: ["ASC", "DESC"]})
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("SORT_DIRECTION_LENGTH_MISMATCH")
      })

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
        const nonExistentId = uuidv7()

        // When
        const response = await get(app, `${endpoint}/${nonExistentId}`).withToken(orgAdminUser.token).build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_NOT_FOUND")
      })
    })
  })

  describe("PUT /workflow-templates/:templateName", () => {
    let createdTemplate: PrismaWorkflowTemplate
    let updatePayload: WorkflowTemplateUpdate

    beforeEach(async () => {
      createdTemplate = await createMockWorkflowTemplateInDb(prisma, {
        name: "Update Template",
        description: "Original description"
      })

      updatePayload = {
        concurrencyControl: {version: createdTemplate.occ.toString()},
        description: "Updated description",
        defaultExpiresInHours: 48
      }
    })

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
        expect(originalTemplate?.version).toEqual(1) // Original template should now have version 1

        const newTemplate = await prisma.workflowTemplate.findUnique({
          where: {id: body.id}
        })
        expect(newTemplate?.description).toEqual(updatePayload.description)
        expect(newTemplate?.defaultExpiresInHours).toEqual(updatePayload.defaultExpiresInHours)
        expect(newTemplate?.status).toEqual("ACTIVE") // New template should be active
        expect(newTemplate?.version).toEqual(2) // New template should be 2
      })

      it("should update workflow template by ID (as OrgAdmin)", async () => {
        // When
        const response = await put(app, `${endpoint}/${createdTemplate.id}`)
          .withToken(orgAdminUser.token)
          .build()
          .send(updatePayload)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: WorkflowTemplateApi = response.body
        expect(body.id).not.toEqual(createdTemplate.id)
        expect(body.name).toEqual(createdTemplate.name)
        expect(body.description).toEqual(updatePayload.description)
      })

      it("should return 400 if updating a non-active template by ID", async () => {
        // Given a deprecated template
        await prisma.workflowTemplate.update({
          where: {id: createdTemplate.id},
          data: {status: "DEPRECATED"}
        })

        // When
        const response = await put(app, `${endpoint}/${createdTemplate.id}`)
          .withToken(orgAdminUser.token)
          .build()
          .send(updatePayload)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_NOT_ACTIVE")
      })

      it("should update only provided fields", async () => {
        // Given
        const partialUpdate: WorkflowTemplateUpdate = {
          concurrencyControl: {version: createdTemplate.occ.toString()},
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
          concurrencyControl: {version: createdTemplate.occ.toString()},
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
        expect(body.version).toEqual("2")

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

      it("should return 404 WORKFLOW_TEMPLATE_NOT_FOUND for non-existent template", async () => {
        // Given
        const nonExistentId = uuidv7()

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
          concurrencyControl: {version: createdTemplate.occ.toString()},
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

  describe("POST /workflow-templates/:templateIdentifier/deprecate", () => {
    let createdTemplate: PrismaWorkflowTemplate

    beforeEach(async () => {
      createdTemplate = await createMockWorkflowTemplateInDb(prisma, {
        name: "Deprecate Template",
        status: "ACTIVE"
      })
    })

    describe("good cases", () => {
      it("should deprecate workflow template by name", async () => {
        // When
        const response = await post(app, `${endpoint}/${createdTemplate.name}/deprecate`)
          .withToken(orgAdminUser.token)
          .build()
          .send({})

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.status).toEqual("PENDING_DEPRECATION")

        const updatedTemplate = await prisma.workflowTemplate.findUnique({where: {id: createdTemplate.id}})
        expect(updatedTemplate?.status).toEqual("PENDING_DEPRECATION")
      })

      it("should deprecate workflow template by ID", async () => {
        const response = await post(app, `${endpoint}/${createdTemplate.id}/deprecate`)
          .withToken(orgAdminUser.token)
          .build()
          .send({})

        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body.status).toEqual("PENDING_DEPRECATION")

        const updatedTemplate = await prisma.workflowTemplate.findUnique({where: {id: createdTemplate.id}})
        expect(updatedTemplate?.status).toEqual("PENDING_DEPRECATION")
      })

      it("should return 400 if deprecating a non-active template by ID", async () => {
        // Given a deprecated template
        await prisma.workflowTemplate.update({
          where: {id: createdTemplate.id},
          data: {status: "DEPRECATED"}
        })

        // When
        const response = await post(app, `${endpoint}/${createdTemplate.id}/deprecate`)
          .withToken(orgAdminUser.token)
          .build()
          .send({})

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_TEMPLATE_NOT_ACTIVE")
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        const response = await post(app, `${endpoint}/${createdTemplate.name}/deprecate`).build().send({})
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 404 NOT_FOUND for non-existent template", async () => {
        const response = await post(app, `${endpoint}/non-existent-template/deprecate`)
          .withToken(orgAdminUser.token)
          .build()
          .send({})

        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("ACTIVE_WORKFLOW_TEMPLATE_NOT_FOUND")
      })
    })
  })
})
