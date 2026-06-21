import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {
  createDomainMockUserInDb,
  MockConfigProvider,
  createMockSpaceInDb,
  createMockGroupInDb,
  createMockAgentInDb
} from "@test/mock-data"
import {post} from "@test/requests"
import {UserWithToken} from "@test/types"
import {TokenPayloadBuilder} from "@services"
import {v7 as uuidv7} from "uuid"
import {ResourceResolveResponse} from "@approvio/api"
import {mapAgentToDomain} from "@external/database/shared"
import {unwrapRight} from "@utils/either"

describe("Resources Resolve API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider

  const endpoint = "/resources/resolve"

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

    const adminTokenPayload = TokenPayloadBuilder.fromUser(adminUser, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })

    orgAdminUser = {user: adminUser, token: jwtService.sign(adminTokenPayload)}
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
    jest.restoreAllMocks()
  })

  it("should be defined", () => {
    expect(app).toBeDefined()
  })

  describe("POST /resources/resolve", () => {
    it("should resolve space and group for org admin", async () => {
      // Given
      const space = await createMockSpaceInDb(prisma, {name: "Space 1"})
      const group = await createMockGroupInDb(prisma, {name: "Group 1"})

      const requestBody = {
        resources: [
          {type: "space", id: space.id},
          {type: "group", id: group.id}
        ]
      }

      // When
      const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

      // Then
      expect(response).toHaveStatusCode(HttpStatus.OK)
      const body: ResourceResolveResponse = response.body
      expect(body.resolved).toHaveLength(2)
      expect(body.resolved).toEqual(
        expect.arrayContaining([
          {type: "space", id: space.id, name: "Space 1"},
          {type: "group", id: group.id, name: "Group 1"}
        ])
      )
      expect(body.denied).toHaveLength(0)
    })

    it("should resolve resources user has access to, and deny others", async () => {
      // Given
      const spaceAllowed = await createMockSpaceInDb(prisma, {name: "Allowed Space"})
      const spaceDenied = await createMockSpaceInDb(prisma, {name: "Denied Space"})
      const groupAllowed = await createMockGroupInDb(prisma, {name: "Allowed Group"})
      const groupDenied = await createMockGroupInDb(prisma, {name: "Denied Group"})

      // Create member user with read permissions on allowed resources
      const user = await createDomainMockUserInDb(prisma, {
        orgAdmin: false,
        roles: [
          {
            name: "SpaceReader",
            resourceType: "space",
            permissions: ["read"],
            scopeType: "space",
            scope: {type: "space", spaceId: spaceAllowed.id}
          },
          {
            name: "GroupReader",
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group",
            scope: {type: "group", groupId: groupAllowed.id}
          }
        ]
      })

      const tokenPayload = TokenPayloadBuilder.fromUser(user, {
        issuer: configProvider.jwtConfig.issuer,
        audience: [configProvider.jwtConfig.audience]
      })
      const userToken = jwtService.sign(tokenPayload)

      const requestBody = {
        resources: [
          {type: "space", id: spaceAllowed.id},
          {type: "space", id: spaceDenied.id},
          {type: "group", id: groupAllowed.id},
          {type: "group", id: groupDenied.id}
        ]
      }

      // When
      const response = await post(app, endpoint).withToken(userToken).build().send(requestBody)

      // Then
      expect(response).toHaveStatusCode(HttpStatus.OK)
      const body: ResourceResolveResponse = response.body
      expect(body.resolved).toHaveLength(2)
      expect(body.resolved).toEqual(
        expect.arrayContaining([
          {type: "space", id: spaceAllowed.id, name: "Allowed Space"},
          {type: "group", id: groupAllowed.id, name: "Allowed Group"}
        ])
      )
      expect(body.denied).toHaveLength(2)
      expect(body.denied).toEqual(
        expect.arrayContaining([
          {type: "space", id: spaceDenied.id, reason: "NOT_AUTHORIZED"},
          {type: "group", id: groupDenied.id, reason: "NOT_AUTHORIZED"}
        ])
      )
    })

    it("should return NOT_FOUND for non-existent spaces and groups", async () => {
      // Given
      const nonExistentSpaceId = uuidv7()
      const nonExistentGroupId = uuidv7()

      const requestBody = {
        resources: [
          {type: "space", id: nonExistentSpaceId},
          {type: "group", id: nonExistentGroupId}
        ]
      }

      // When
      const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)

      // Then
      expect(response).toHaveStatusCode(HttpStatus.OK)
      const body: ResourceResolveResponse = response.body
      expect(body.resolved).toHaveLength(0)
      expect(body.denied).toHaveLength(2)
      expect(body.denied).toEqual(
        expect.arrayContaining([
          {type: "space", id: nonExistentSpaceId, reason: "NOT_FOUND"},
          {type: "group", id: nonExistentGroupId, reason: "NOT_FOUND"}
        ])
      )
    })

    it("should return MISSING_RESOURCES when resources parameter is missing", async () => {
      const requestBody = {}
      const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      expect(response.body.code).toBe("MISSING_RESOURCES")
    })

    it("should return EMPTY_RESOURCES when resources is empty", async () => {
      const requestBody = {resources: []}
      const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      expect(response.body.code).toBe("EMPTY_RESOURCES")
    })

    it("should return TOO_MANY_RESOURCES when resources has more than 50 items", async () => {
      const resources = Array.from({length: 51}, () => ({
        type: "space",
        id: uuidv7()
      }))
      const requestBody = {resources}
      const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(requestBody)
      expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      expect(response.body.code).toBe("TOO_MANY_RESOURCES")
    })

    it("should return UNAUTHORIZED when no token is provided", async () => {
      const requestBody = {
        resources: [{type: "space", id: uuidv7()}]
      }
      const response = await post(app, endpoint).build().send(requestBody)
      expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
    })

    it("should return UNAUTHORIZED when an agent token is used", async () => {
      // Given
      const agent = await createMockAgentInDb(prisma)
      const domainAgent = unwrapRight(mapAgentToDomain(agent))
      const agentTokenPayload = TokenPayloadBuilder.fromAgent(domainAgent, {
        issuer: configProvider.jwtConfig.issuer,
        audience: [configProvider.jwtConfig.audience]
      })
      const agentToken = jwtService.sign(agentTokenPayload)

      const requestBody = {
        resources: [{type: "space", id: uuidv7()}]
      }

      // When
      const response = await post(app, endpoint).withToken(agentToken).build().send(requestBody)

      // Then
      expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
      expect(response.body.code).toBe("REQUESTOR_NOT_AUTHORIZED")
    })
  })
})
