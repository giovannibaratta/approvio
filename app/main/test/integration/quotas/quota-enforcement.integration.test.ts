import {randomOrgId} from "@test/organization-id"
import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {SPACES_ENDPOINT_ROOT, GROUPS_ENDPOINT_ROOT, WORKFLOWS_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient} from "@prisma/client"

import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {
  createDomainMockUserInDb,
  createMockSpaceInDb,
  createMockGroupInDb,
  createMockWorkflowTemplateInDb,
  MockConfigProvider
} from "@test/mock-data"
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {get, post, put} from "@test/requests"
import {UserWithToken} from "@test/types"
import {v7 as uuidv7} from "uuid"

describe("Quota Enforcement API Integration", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

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
    configProvider = module.get(ConfigProvider)
    await app.init()
  }, 30000)

  beforeEach(async () => {
    orgAdminUser = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      orgAdmin: true,
      organizationId: randomOrgId()
    })
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
          organizationId: orgAdminUser.user.organizationId,
          targetId: orgAdminUser.user.organizationId,
          limit: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n
        }
      })

      // Create first space (success)
      const spacesEndpoint = `/o/${orgAdminUser.user.organizationId}/${SPACES_ENDPOINT_ROOT}`
      const resp1 = await post(app, spacesEndpoint).withToken(orgAdminUser.token).build().send({name: "Space 1"})
      expect(resp1).toHaveStatusCode(HttpStatus.CREATED)

      // Create second space (failure)
      const resp2 = await post(app, spacesEndpoint).withToken(orgAdminUser.token).build().send({name: "Space 2"})

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
          organizationId: orgAdminUser.user.organizationId,
          targetId: orgAdminUser.user.organizationId,
          limit: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n
        }
      })

      // Create first group (success)
      const groupsEndpoint = `/o/${orgAdminUser.user.organizationId}/${GROUPS_ENDPOINT_ROOT}`
      const resp1 = await post(app, groupsEndpoint).withToken(orgAdminUser.token).build().send({name: "Group-1"})
      expect(resp1).toHaveStatusCode(HttpStatus.CREATED)

      // Create second group (failure)
      const resp2 = await post(app, groupsEndpoint).withToken(orgAdminUser.token).build().send({name: "Group-2"})

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
          organizationId: orgAdminUser.user.organizationId,
          targetId: orgAdminUser.user.organizationId,
          limit: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n
        }
      })

      const targetUser = await createDomainMockUserInDb(prisma, {
        orgAdmin: false,
        organizationId: orgAdminUser.user.organizationId
      })

      const userEndpoint = `/o/${orgAdminUser.user.organizationId}/users/${targetUser.id}`
      const userToUpdate = await get(app, userEndpoint).withToken(orgAdminUser.token).build()
      expect(userToUpdate).toHaveStatusCode(HttpStatus.OK)
      expect(userToUpdate.headers.etag).toBeDefined()

      // Add first role (success)
      const userRolesEndpoint = `${userEndpoint}/roles`
      const resp1 = await put(app, userRolesEndpoint)
        .withToken(orgAdminUser.token)
        .withHeader("If-Match", userToUpdate.headers.etag ?? "")
        .build()
        .send({roles: [{roleName: "OrgWideSpaceReadOnly", scope: {type: "org"}}]})
      expect(resp1).toHaveStatusCode(HttpStatus.NO_CONTENT)

      // Fetch updated user to get the new ETag
      const updatedUser = await get(app, userEndpoint).withToken(orgAdminUser.token).build()
      expect(updatedUser).toHaveStatusCode(HttpStatus.OK)
      expect(updatedUser.headers.etag).toBe(resp1.headers.etag)
      expect(updatedUser.headers.etag).not.toBe(userToUpdate.headers.etag)

      // Add second role (failure)
      const resp2 = await put(app, userRolesEndpoint)
        .withToken(orgAdminUser.token)
        .withHeader("If-Match", updatedUser.headers.etag ?? "")
        .build()
        .send({roles: [{roleName: "OrgWideWorkflowTemplateReadOnly", scope: {type: "org"}}]})

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
          organizationId: orgAdminUser.user.organizationId,
          targetId: orgAdminUser.user.organizationId,
          limit: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n
        }
      })

      const space = await createMockSpaceInDb(prisma, {organizationId: orgAdminUser.user.organizationId})
      const template = await createMockWorkflowTemplateInDb(prisma, {
        organizationId: orgAdminUser.user.organizationId,
        spaceId: space.id
      })

      // Create first workflow (success)
      const workflowEndpoint = `/o/${orgAdminUser.user.organizationId}/${WORKFLOWS_ENDPOINT_ROOT}`
      const resp1 = await post(app, workflowEndpoint).withToken(orgAdminUser.token).build().send({
        name: "Workflow-1",
        workflowTemplateId: template.id
      })
      expect(resp1).toHaveStatusCode(HttpStatus.CREATED)

      // Create second workflow (failure)
      const resp2 = await post(app, workflowEndpoint).withToken(orgAdminUser.token).build().send({
        name: "Workflow-2",
        workflowTemplateId: template.id
      })

      expect(resp2).toHaveStatusCode(HttpStatus.FORBIDDEN)
      expect(resp2.body).toHaveErrorCode("QUOTA_EXCEEDED")
    })
  })

  const workflowTemplatesEndpoint = () => `/o/${orgAdminUser.user.organizationId}/workflow-templates`

  describe("MAX_WORKFLOW_TEMPLATES_PER_SPACE enforcement", () => {
    it("should return 403 quota_exceeded when MAX_WORKFLOW_TEMPLATES_PER_SPACE limit is reached", async () => {
      const space = await createMockSpaceInDb(prisma, {organizationId: orgAdminUser.user.organizationId})

      const group = await createMockGroupInDb(prisma, {organizationId: orgAdminUser.user.organizationId})

      // Set quota limit to 1 for this space
      await prisma.quota.create({
        data: {
          id: uuidv7(),
          scope: "Space",
          quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE",
          organizationId: orgAdminUser.user.organizationId,
          targetId: space.id,
          limit: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n
        }
      })

      // Create first template (success)
      const resp1 = await post(app, workflowTemplatesEndpoint())
        .withToken(orgAdminUser.token)
        .build()
        .send({
          name: "Template-1",
          description: "Desc",
          spaceId: space.id,
          approvalRule: {
            type: "GROUP_REQUIREMENT",
            groupId: group.id,
            minCount: 1
          }
        })
      expect(resp1).toHaveStatusCode(HttpStatus.CREATED)

      // Create second template (failure)
      const resp2 = await post(app, workflowTemplatesEndpoint())
        .withToken(orgAdminUser.token)
        .build()
        .send({
          name: "Template-2",
          description: "Desc",
          spaceId: space.id,
          approvalRule: {
            type: "GROUP_REQUIREMENT",
            groupId: group.id,
            minCount: 1
          }
        })

      expect(resp2).toHaveStatusCode(HttpStatus.FORBIDDEN)
      expect(resp2.body).toHaveErrorCode("QUOTA_EXCEEDED")
    })
  })
})
