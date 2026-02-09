import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {AGENTS_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient} from "@prisma/client"
import {AgentRegistrationRequest} from "@approvio/api"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {createDomainMockUserInDb, MockConfigProvider} from "@test/mock-data"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {get, post} from "@test/requests"
import {UserWithToken} from "@test/types"
import "expect-more-jest"
import "@utils/matchers"
import {TokenPayloadBuilder} from "@services"
import {Chance} from "chance"

const chance = new Chance()

describe("Agents API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgAdminUser: UserWithToken
  let orgMemberUser: UserWithToken

  const endpoint = `/${AGENTS_ENDPOINT_ROOT}/register`

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

    app = module.createNestApplication({logger: ["error", "warn"]})
    prisma = module.get(DatabaseClient)
    const jwtService = module.get(JwtService)
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

    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  describe("POST /agents/register", () => {
    describe("Good cases", () => {
      it("should register agent successfully with valid data", async () => {
        // Given: Valid agent registration request
        const request: AgentRegistrationRequest = {
          agentName: "test-ci-agent"
        }

        // When: Posting to registration endpoint as admin
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(request)

        // Expect: Successful agent registration
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.body).toMatchObject({
          agentName: "test-ci-agent",
          agentId: expect.toBeString(),
          publicKey: expect.toBeString(),
          privateKey: expect.toBeString(),
          createdAt: expect.toBeString()
        })

        // Expect: Valid UUID for agent ID
        expect(response.body.agentId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        )

        // Expect: Keys are base64 encoded
        expect(response.body.publicKey).toMatch(/^[A-Za-z0-9+/]+=*$/)
        expect(response.body.privateKey).toMatch(/^[A-Za-z0-9+/]+=*$/)

        // Expect: Location header is set
        expect(response.headers.location).toMatch(new RegExp(`/agents/${response.body.agentId}$`))

        // Expect: Agent is persisted in database
        const dbAgent = await prisma.agent.findUnique({
          where: {agentName: "test-ci-agent"}
        })
        expect(dbAgent).toBeTruthy()
        expect(dbAgent?.id).toBe(response.body.agentId)
      })

      it("should handle agent names with special characters", async () => {
        // Given: Agent name with allowed special characters
        const request: AgentRegistrationRequest = {
          agentName: "test-agent_123-deployment"
        }

        // When: Posting to registration endpoint as admin
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(request)

        // Expect: Successful registration
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.body.agentName).toBe("test-agent_123-deployment")
      })

      it("should handle maximum length agent name", async () => {
        // Given: Agent name at maximum allowed length (1024 characters)
        const maxLengthName = "a".repeat(1024)
        const request: AgentRegistrationRequest = {
          agentName: maxLengthName
        }

        // When: Posting to registration endpoint as admin
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(request)

        // Expect: Successful registration
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.body.agentName).toBe(maxLengthName)
      })
    })

    describe("Bad cases", () => {
      it("should reject empty agent name", async () => {
        // Given: Empty agent name
        const request: AgentRegistrationRequest = {
          agentName: ""
        }

        // When: Posting to registration endpoint as admin
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(request)

        // Expect: Bad request error
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("AGENT_NAME_EMPTY")
      })

      it("should reject agent name that is too long", async () => {
        // Given: Agent name exceeding maximum length
        const tooLongName = "a".repeat(1025)
        const request: AgentRegistrationRequest = {
          agentName: tooLongName
        }

        // When: Posting to registration endpoint as admin
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(request)

        // Expect: Bad request error
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("AGENT_NAME_TOO_LONG")
      })

      it("should reject whitespace-only agent name", async () => {
        // Given: Whitespace-only agent name
        const request: AgentRegistrationRequest = {
          agentName: "   "
        }

        // When: Posting to registration endpoint as admin
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(request)

        // Expect: Bad request error
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("AGENT_NAME_EMPTY")
      })

      it("should reject duplicate agent names", async () => {
        // Given: An existing agent in the database
        const agentName = "duplicate-agent"
        await prisma.agent.create({
          data: {
            id: "550e8400-e29b-41d4-a716-446655440000",
            agentName,
            base64PublicKey: "dGVzdC1wdWJsaWMta2V5",
            createdAt: new Date(),
            occ: BigInt(0)
          }
        })

        const request: AgentRegistrationRequest = {
          agentName
        }

        // When: Trying to register agent with same name as admin
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(request)

        // Expect: Conflict error
        expect(response).toHaveStatusCode(HttpStatus.CONFLICT)
        expect(response.body).toHaveErrorCode("AGENT_NAME_ALREADY_EXISTS")
      })

      it("should reject missing agent name in request body", async () => {
        // Given: Request without agentName
        const request = {}

        // When: Posting to registration endpoint as admin
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(request)

        // Expect: Bad request due to validation
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
      })

      it("should reject agent name that is a UUID", async () => {
        // Given: Agent name that is a valid UUID
        const request: AgentRegistrationRequest = {
          agentName: "550e8400-e29b-41d4-a716-446655440000"
        }

        // When: Posting to registration endpoint as admin
        const response = await post(app, endpoint).withToken(orgAdminUser.token).build().send(request)

        // Expect: Bad request error
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("AGENT_NAME_CANNOT_BE_UUID")
      })
    })

    describe("Authentication cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // Given: Valid agent registration request
        const request: AgentRegistrationRequest = {
          agentName: "test-unauthenticated-agent"
        }

        // When: Posting without authentication token
        const response = await post(app, endpoint).build().send(request)

        // Expect: Unauthorized error
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should allow member users to register agents", async () => {
        // Given: Valid agent registration request
        const request: AgentRegistrationRequest = {
          agentName: "test-member-agent"
        }

        // When: Posting as member user (not admin)
        const response = await post(app, endpoint).withToken(orgMemberUser.token).build().send(request)

        // Expect: Successful registration
        expect(response).toHaveStatusCode(HttpStatus.CREATED)
        expect(response.body).toMatchObject({
          agentName: "test-member-agent",
          agentId: expect.toBeString(),
          publicKey: expect.toBeString(),
          privateKey: expect.toBeString(),
          createdAt: expect.toBeString()
        })
      })
    })
  })

  describe("GET /agents/:idOrName", () => {
    let existingAgent: {id: string; agentName: string}

    beforeEach(async () => {
      existingAgent = {
        id: chance.guid(),
        agentName: chance.word()
      }
      await prisma.agent.create({
        data: {
          id: existingAgent.id,
          agentName: existingAgent.agentName,
          base64PublicKey: "dGVzdC1wdWJsaWMta2V5",
          createdAt: new Date(),
          occ: BigInt(0)
        }
      })
    })

    describe("Good cases", () => {
      it("should fetch agent details by ID", async () => {
        // When: Fetching agent by ID
        const response = await get(app, `/${AGENTS_ENDPOINT_ROOT}/${existingAgent.id}`)
          .withToken(orgAdminUser.token)
          .build()
          .send()

        // Expect: Successful retrieval
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body).toMatchObject({
          id: existingAgent.id,
          agentName: existingAgent.agentName,
          publicKey: expect.toBeString(),
          createdAt: expect.toBeString()
        })
      })

      it("should fetch agent details by name", async () => {
        // When: Fetching agent by name
        const response = await get(app, `/${AGENTS_ENDPOINT_ROOT}/${existingAgent.agentName}`)
          .withToken(orgAdminUser.token)
          .build()
          .send()

        // Expect: Successful retrieval
        expect(response).toHaveStatusCode(HttpStatus.OK)
        expect(response.body).toMatchObject({
          id: existingAgent.id,
          agentName: existingAgent.agentName,
          publicKey: expect.toBeString(),
          createdAt: expect.toBeString()
        })
      })
    })

    describe("Bad cases", () => {
      it("should return 404 NOT FOUND if agent does not exist (by ID)", async () => {
        // When: Fetching non-existent agent by ID
        const response = await get(app, `/${AGENTS_ENDPOINT_ROOT}/${chance.guid()}`)
          .withToken(orgAdminUser.token)
          .build()
          .send()

        // Expect: Not found error
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("AGENT_NOT_FOUND")
      })

      it("should return 404 NOT FOUND if agent does not exist (by name)", async () => {
        // When: Fetching non-existent agent by name
        const response = await get(app, `/${AGENTS_ENDPOINT_ROOT}/non-existent-agent`)
          .withToken(orgAdminUser.token)
          .build()
          .send()

        // Expect: Not found error
        expect(response).toHaveStatusCode(HttpStatus.NOT_FOUND)
        expect(response.body).toHaveErrorCode("AGENT_NOT_FOUND")
      })
    })

    describe("Authentication cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When: Fetching without authentication token
        const response = await get(app, `/${AGENTS_ENDPOINT_ROOT}/${existingAgent.id}`).build().send()

        // Expect: Unauthorized error
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })
    })
  })
})
