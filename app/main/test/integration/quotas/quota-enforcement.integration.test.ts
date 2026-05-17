import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {SPACES_ENDPOINT_ROOT, GROUPS_ENDPOINT_ROOT, USERS_ENDPOINT_ROOT, WORKFLOWS_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient} from "@prisma/client"

import {cleanDatabase, prepareDatabase} from "@test/database"
import {
  createDomainMockUserInDb,
  createMockSpaceInDb,
  createMockWorkflowTemplateInDb,
  MockConfigProvider
} from "@test/mock-data"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {post, put} from "@test/requests"
import {UserWithToken} from "@test/types"
import {TokenPayloadBuilder, DEFAULT_ORG_ID} from "@services"
import {v7 as uuidv7} from "uuid"

describe("Quota Enforcement API Integration", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let orgAdminUser: UserWithToken

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

    const tokenPayload = TokenPayloadBuilder.from({
      sub: adminUser.id,
      entityType: "user",
      displayName: adminUser.displayName,
      email: adminUser.email,
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })

    orgAdminUser = {user: adminUser, token: jwtService.sign(tokenPayload)}
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  describe("MAX_SPACES enforcement", () => {
    it("should return 403 quota_exceeded when MAX_SPACES limit is reached", async () => {
      // Set quota limit to 1
      await prisma.quota.create({
        data: {
          id: uuidv7(),
          scope: "Org",
          quotaType: "MAX_SPACES",
          targetId: DEFAULT_ORG_ID,
          limit: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n
        }
      })

      // Create first space (success)
      const resp1 = await post(app, `/${SPACES_ENDPOINT_ROOT}`)
        .withToken(orgAdminUser.token)
        .build()
        .send({name: "Space 1"})
      expect(resp1).toHaveStatusCode(HttpStatus.CREATED)

      // Create second space (failure)
      const resp2 = await post(app, `/${SPACES_ENDPOINT_ROOT}`)
        .withToken(orgAdminUser.token)
        .build()
        .send({name: "Space 2"})

      expect(resp2).toHaveStatusCode(HttpStatus.FORBIDDEN)
      expect(resp2.body).toHaveErrorCode("QUOTA_EXCEEDED")
    })
  })

  describe("MAX_GROUPS enforcement", () => {
    it("should return 403 quota_exceeded when MAX_GROUPS limit is reached", async () => {
      // Set quota limit to 1
      await prisma.quota.create({
        data: {
          id: uuidv7(),
          scope: "Org",
          quotaType: "MAX_GROUPS",
          targetId: DEFAULT_ORG_ID,
          limit: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n
        }
      })

      // Create first group (success)
      const resp1 = await post(app, `/${GROUPS_ENDPOINT_ROOT}`)
        .withToken(orgAdminUser.token)
        .build()
        .send({name: "Group-1"})
      expect(resp1).toHaveStatusCode(HttpStatus.CREATED)

      // Create second group (failure)
      const resp2 = await post(app, `/${GROUPS_ENDPOINT_ROOT}`)
        .withToken(orgAdminUser.token)
        .build()
        .send({name: "Group-2"})

      expect(resp2).toHaveStatusCode(HttpStatus.FORBIDDEN)
      expect(resp2.body).toHaveErrorCode("QUOTA_EXCEEDED")
    })
  })

  describe("MAX_ROLES_PER_USER enforcement", () => {
    it("should return 403 quota_exceeded when adding a role exceeds MAX_ROLES_PER_USER", async () => {
      // Set quota limit to 1
      await prisma.quota.create({
        data: {
          id: uuidv7(),
          scope: "Org",
          quotaType: "MAX_ROLES_PER_USER",
          targetId: DEFAULT_ORG_ID,
          limit: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n
        }
      })

      const targetUser = await createDomainMockUserInDb(prisma, {orgAdmin: false})

      const userToUpdate = await prisma.user.findUniqueOrThrow({where: {id: targetUser.id}})

      // Add first role (success)
      const resp1 = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.id}/roles`)
        .withToken(orgAdminUser.token)
        .build()
        .send({
          roles: [{roleName: "OrgWideSpaceReadOnly", scope: {type: "org"}}],
          concurrencyControl: {version: userToUpdate.occ.toString()}
        })
      expect(resp1).toHaveStatusCode(HttpStatus.NO_CONTENT)

      // Fetch updated user to get new OCC version
      const updatedUser = await prisma.user.findUniqueOrThrow({where: {id: targetUser.id}})

      // Add second role (failure)
      const resp2 = await put(app, `/${USERS_ENDPOINT_ROOT}/${targetUser.id}/roles`)
        .withToken(orgAdminUser.token)
        .build()
        .send({
          roles: [{roleName: "OrgWideWorkflowTemplateReadOnly", scope: {type: "org"}}],
          concurrencyControl: {version: updatedUser.occ.toString()}
        })

      expect(resp2).toHaveStatusCode(HttpStatus.FORBIDDEN)
      expect(resp2.body).toHaveErrorCode("QUOTA_EXCEEDED")
    })
  })

  describe("MAX_CONCURRENT_WORKFLOWS enforcement", () => {
    it("should return 403 quota_exceeded when MAX_CONCURRENT_WORKFLOWS limit is reached", async () => {
      // Set quota limit to 1
      await prisma.quota.create({
        data: {
          id: uuidv7(),
          scope: "Org",
          quotaType: "MAX_CONCURRENT_WORKFLOWS",
          targetId: DEFAULT_ORG_ID,
          limit: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n
        }
      })

      const space = await createMockSpaceInDb(prisma)
      const template = await createMockWorkflowTemplateInDb(prisma, {spaceId: space.id})

      // Create first workflow (success)
      const resp1 = await post(app, `/${WORKFLOWS_ENDPOINT_ROOT}`).withToken(orgAdminUser.token).build().send({
        name: "Workflow-1",
        workflowTemplateId: template.id
      })
      expect(resp1).toHaveStatusCode(HttpStatus.CREATED)

      // Create second workflow (failure)
      const resp2 = await post(app, `/${WORKFLOWS_ENDPOINT_ROOT}`).withToken(orgAdminUser.token).build().send({
        name: "Workflow-2",
        workflowTemplateId: template.id
      })

      expect(resp2).toHaveStatusCode(HttpStatus.FORBIDDEN)
      expect(resp2.body).toHaveErrorCode("QUOTA_EXCEEDED")
    })
  })

  const workflowTemplatesEndpoint: string = "workflow-templates"

  describe("MAX_WORKFLOW_TEMPLATES_PER_SPACE enforcement", () => {
    it("should return 403 quota_exceeded when MAX_WORKFLOW_TEMPLATES_PER_SPACE limit is reached", async () => {
      const space = await createMockSpaceInDb(prisma)

      // Set quota limit to 1 for this space
      await prisma.quota.create({
        data: {
          id: uuidv7(),
          scope: "Space",
          quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE",
          targetId: space.id,
          limit: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n
        }
      })

      // Create first template (success)
      const resp1 = await post(app, `/${workflowTemplatesEndpoint}`)
        .withToken(orgAdminUser.token)
        .build()
        .send({
          name: "Template-1",
          description: "Desc",
          spaceId: space.id,
          approvalRule: {
            type: "GROUP_REQUIREMENT",
            groupId: uuidv7(),
            minCount: 1
          }
        })
      expect(resp1).toHaveStatusCode(HttpStatus.CREATED)

      // Create second template (failure)
      const resp2 = await post(app, `/${workflowTemplatesEndpoint}`)
        .withToken(orgAdminUser.token)
        .build()
        .send({
          name: "Template-2",
          description: "Desc",
          spaceId: space.id,
          approvalRule: {
            type: "GROUP_REQUIREMENT",
            groupId: uuidv7(),
            minCount: 1
          }
        })

      expect(resp2).toHaveStatusCode(HttpStatus.FORBIDDEN)
      expect(resp2.body).toHaveErrorCode("QUOTA_EXCEEDED")
    })
  })
})
