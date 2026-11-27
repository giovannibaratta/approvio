import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {PrismaClient, WorkflowTemplate as PrismaWorkflowTemplate} from "@prisma/client"
import {createMockWorkflowTemplateInDb, MockConfigProvider} from "@test/mock-data"
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import {HttpStatus} from "@nestjs/common"
import {post} from "@test/requests"
import "expect-more-jest"
import "@utils/matchers"
import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {TestingModule, Test} from "@nestjs/testing"
import {createFixturePrismaClient, prepareDatabase, cleanDatabase} from "@test/database"
import {UserWithToken} from "@test/types"
import {WorkflowTemplateService} from "@services"

describe("Workflow Templates internal API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let jwtService: JwtService
  let workflowTemplates: WorkflowTemplateService

  let endpoint: string
  let organizationId: ReturnType<typeof toOrganizationId>

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()
    organizationId = randomOrgId()

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
    workflowTemplates = module.get(WorkflowTemplateService)
    const configProvider = module.get(ConfigProvider)

    orgAdminUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      orgAdmin: true,
      organizationId
    })
    endpoint = `/internal/o/${organizationId}/workflow-template`

    await app.init()
  }, 30000)

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  describe("POST /internal/o/:organizationId/workflow-template/:templateId/cancel-workflows", () => {
    let createdTemplate: PrismaWorkflowTemplate

    beforeEach(async () => {
      createdTemplate = await createMockWorkflowTemplateInDb(prisma, {
        organizationId,
        name: "Cancel Workflows Template",
        description: "Template for cancel workflows test"
      })
    })

    describe("internal authorization", () => {
      it("keeps cancellation off HTTP until worker authentication is available", async () => {
        // Given - First mark template for deprecation (PENDING_DEPRECATION state)
        await prisma.workflowTemplate.update({
          where: {id: createdTemplate.id},
          data: {
            status: "PENDING_DEPRECATION",
            version: 1,
            allowVotingOnDeprecatedTemplate: false
          }
        })

        // When
        const response = await post(app, `${endpoint}/${createdTemplate.id}/cancel-workflows`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(await prisma.workflowTemplate.findUniqueOrThrow({where: {id: createdTemplate.id}})).toMatchObject({
          status: "PENDING_DEPRECATION"
        })

        // The operation remains available to trusted in-process callers.
        const result = await workflowTemplates.cancelWorkflowsAndDeprecateTemplate(
          {organizationId},
          createdTemplate.id
        )()
        expect(result).toBeRight()

        // Validate side effects in DB
        const deprecatedTemplate = await prisma.workflowTemplate.findUnique({
          where: {id: createdTemplate.id}
        })
        expect(deprecatedTemplate).toBeDefined()
        expect(deprecatedTemplate?.status).toBe("DEPRECATED")
      })
    })
  })
})
