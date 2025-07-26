import {PrismaClient, WorkflowTemplate as PrismaWorkflowTemplate} from "@prisma/client"
import {createDomainMockUserInDb, createMockWorkflowTemplateInDb, MockConfigProvider} from "../shared/mock-data"
import {HttpStatus} from "@nestjs/common"
import {post} from "../shared/requests"
import "expect-more-jest"
import "@utils/matchers"
import {AppModule} from "@app/app.module"
import {WORKFLOW_TEMPLATE_INTERNAL_ENDPOINT_ROOT} from "@controllers"
import {OrgRole} from "@domain"
import {DatabaseClient} from "@external"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {TestingModule, Test} from "@nestjs/testing"
import {prepareDatabase, cleanDatabase} from "../database"
import {UserWithToken} from "../shared/types"

describe("Workflow Templates internal API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let jwtService: JwtService

  const endpoint = `/${WORKFLOW_TEMPLATE_INTERNAL_ENDPOINT_ROOT}`

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(new MockConfigProvider(isolatedDb))
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication()
    prisma = module.get(DatabaseClient)
    jwtService = module.get(JwtService)

    const adminUser = await createDomainMockUserInDb(prisma, {orgRole: OrgRole.ADMIN})
    orgAdminUser = {user: adminUser, token: jwtService.sign({email: adminUser.email, sub: adminUser.id})}

    await app.init()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  describe("POST /internal/workflow-template/:templateId/cancel-workflows", () => {
    let createdTemplate: PrismaWorkflowTemplate

    beforeEach(async () => {
      createdTemplate = await createMockWorkflowTemplateInDb(prisma, {
        name: "Cancel Workflows Template",
        description: "Template for cancel workflows test"
      })
    })

    describe("good cases", () => {
      it("should cancel workflows and deprecate template", async () => {
        // Given - First mark template for deprecation (PENDING_DEPRECATION state)
        await prisma.workflowTemplate.update({
          where: {id: createdTemplate.id},
          data: {
            status: "PENDING_DEPRECATION",
            version: "1",
            allowVotingOnDeprecatedTemplate: false
          }
        })

        // When
        const response = await post(app, `${endpoint}/${createdTemplate.id}/cancel-workflows`)
          .withToken(orgAdminUser.token)
          .build()

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.OK)

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
