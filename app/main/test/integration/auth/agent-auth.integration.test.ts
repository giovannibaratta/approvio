import {Test, TestingModule} from "@nestjs/testing"
import {HttpStatus, INestApplication} from "@nestjs/common"
import * as supertest from "supertest"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external/database"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider} from "@test/mock-data"
import {PrismaClient} from "@prisma/client"
import {AgentFactory, AgentWithPrivateKey} from "@domain"
import {AgentChallengeRequest} from "@approvio/api"
import {JwtService} from "@nestjs/jwt"

import {constants, privateDecrypt, sign} from "crypto"
import "expect-more-jest"
import "@utils/matchers"
import {isLeft} from "fp-ts/lib/Either"
import {JwtAssertionTokenRequest} from "@controllers/auth/agent-auth.mappers"

describe("Agent Authentication Integration", () => {
  let app: INestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let testAgent: AgentWithPrivateKey

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
    configProvider = module.get(ConfigProvider)

    // Create a test agent for authentication tests
    const agentResult = AgentFactory.create({agentName: "test-agent"})
    if (isLeft(agentResult)) throw new Error("Failed to create test agent")
    testAgent = agentResult.right

    await prisma.agent.create({
      data: {
        id: testAgent.id,
        agentName: testAgent.agentName,
        base64PublicKey: Buffer.from(testAgent.publicKey).toString("base64"),
        createdAt: testAgent.createdAt,
        occ: BigInt(0)
      }
    })

    await app.init()
  }, 20000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  describe("POST /auth/agents/challenge", () => {
    const challengeEndpoint = "/auth/agents/challenge"

    describe("bad cases", () => {
      it("should return 400 when agentName is missing", async () => {
        // Given: Request without agentName
        const challengeRequest: Partial<AgentChallengeRequest> = {}

        // When
        const response = await supertest(app.getHttpServer()).post(challengeEndpoint).send(challengeRequest)

        // Expect
        expect(response).toHaveStatusCode(400)
        expect(response.body).toHaveErrorCode("REQUEST_INVALID_AGENT_NAME")
      })

      it("should return 400 when agentName is empty", async () => {
        // Given: Request with empty agentName
        const challengeRequest: AgentChallengeRequest = {
          agentName: ""
        }

        // When
        const response = await supertest(app.getHttpServer()).post(challengeEndpoint).send(challengeRequest)

        // Expect
        expect(response).toHaveStatusCode(400)
        expect(response.body).toHaveErrorCode("REQUEST_INVALID_AGENT_NAME")
      })

      it("should return 400 when agent does not exist", async () => {
        // Given: Request for non-existent agent
        const challengeRequest: AgentChallengeRequest = {
          agentName: "non-existent-agent"
        }

        // When
        const response = await supertest(app.getHttpServer()).post(challengeEndpoint).send(challengeRequest)

        // Expect
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("AGENT_NOT_FOUND")
      })
    })

    describe("good cases", () => {
      it("should generate encrypted challenge for existing agent", async () => {
        // Given: Valid challenge request
        const challengeRequest: AgentChallengeRequest = {
          agentName: testAgent.agentName
        }

        // When
        const response = await supertest(app.getHttpServer()).post(challengeEndpoint).send(challengeRequest)

        // Expect
        expect(response).toHaveStatusCode(200)
        expect(response.body).toHaveProperty("challenge")
        expect(typeof response.body.challenge).toBe("string")
        expect(response.body.challenge.length).toBeGreaterThan(0)

        // Verify challenge can be decrypted with agent's private key
        const encryptedChallenge = response.body.challenge
        const challengeBuffer = Buffer.from(encryptedChallenge, "base64")

        const decrypted = privateDecrypt(
          {
            key: testAgent.privateKey,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256"
          },
          challengeBuffer
        )

        const challengePayload = JSON.parse(decrypted.toString("utf8"))

        expect(challengePayload).toHaveProperty("audience", testAgent.agentName)
        expect(challengePayload).toHaveProperty("issuer", configProvider.jwtConfig.issuer)
        expect(challengePayload).toHaveProperty("nonce")
        expect(challengePayload).toHaveProperty("expiresAt")
        expect(typeof challengePayload.nonce).toBe("string")
        expect(challengePayload.nonce.length).toBeGreaterThan(0)

        // Verify challenge is stored in database
        const storedChallenge = await prisma.agentChallenge.findFirst({
          where: {nonce: challengePayload.nonce}
        })
        expect(storedChallenge).not.toBeNull()
        expect(storedChallenge?.agentId).toBe(testAgent.id)
        expect(storedChallenge?.usedAt).toBeNull()
      })
    })
  })

  describe("POST /auth/agents/token", () => {
    const tokenEndpoint = "/auth/agents/token"

    // Helper method to generate a challenge and get its payload
    const generateChallengeAndGetPayload = async (): Promise<{
      challenge: string
      payload: Record<string, unknown>
      nonce: string
    }> => {
      const challengeRequest: AgentChallengeRequest = {
        agentName: testAgent.agentName
      }

      const challengeResponse = await supertest(app.getHttpServer())
        .post("/auth/agents/challenge")
        .send(challengeRequest)

      expect(challengeResponse).toHaveStatusCode(200)

      const challengeBuffer = Buffer.from(challengeResponse.body.challenge, "base64")
      const decrypted = privateDecrypt(
        {
          key: testAgent.privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256"
        },
        challengeBuffer
      )

      const payload = JSON.parse(decrypted.toString("utf8"))
      return {
        challenge: challengeResponse.body.challenge,
        payload,
        nonce: payload.nonce
      }
    }

    // Helper method to create JWT assertion
    const createJwtAssertion = (nonce: string, exp?: number): string => {
      const header = {
        alg: "RS256",
        typ: "JWT"
      }

      const payload = {
        iss: testAgent.agentName, // Issuer - agent name
        sub: testAgent.agentName, // Subject - agent name (same as iss for client auth)
        aud: configProvider.jwtConfig.audience, // Audience - authorization server
        exp: exp || Math.floor(Date.now() / 1000) + 300, // Expiration time - 5 minutes from now
        jti: nonce, // JWT ID - unique nonce from challenge
        iat: Math.floor(Date.now() / 1000) // Issued at time
      }

      const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url")
      const signingData = `${headerB64}.${payloadB64}`

      const signature = sign("RSA-SHA256", Buffer.from(signingData), testAgent.privateKey)
      const signatureB64 = signature.toString("base64url")

      return `${signingData}.${signatureB64}`
    }

    describe("JWT assertion flow (RFC 7523)", () => {
      describe("bad cases", () => {
        it("should return 400 when grant_type is missing", async () => {
          // Given: JWT assertion request without grant_type
          const jwtTokenRequest = {
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: "some-jwt"
          }

          // When
          const response = await supertest(app.getHttpServer()).post(tokenEndpoint).send(jwtTokenRequest)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("REQUEST_INVALID_GRANT_TYPE")
        })

        it("should return 400 when client_assertion_type is invalid", async () => {
          // Given: JWT assertion request with invalid assertion type
          const jwtTokenRequest = {
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            client_assertion_type: "invalid-type",
            client_assertion: "some-jwt"
          }

          // When
          const response = await supertest(app.getHttpServer()).post(tokenEndpoint).send(jwtTokenRequest)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("REQUEST_INVALID_CLIENT_ASSERTION_TYPE")
        })

        it("should return 400 when client_assertion is missing", async () => {
          // Given: JWT assertion request without client_assertion
          const jwtTokenRequest = {
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
          }

          // When
          const response = await supertest(app.getHttpServer()).post(tokenEndpoint).send(jwtTokenRequest)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("REQUEST_MISSING_CLIENT_ASSERTION")
        })

        it("should return 400 when JWT assertion is malformed", async () => {
          // Given: JWT assertion request with malformed JWT
          const jwtTokenRequest: JwtAssertionTokenRequest = {
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: "invalid-jwt-format"
          }

          // When
          const response = await supertest(app.getHttpServer()).post(tokenEndpoint).send(jwtTokenRequest)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("AGENT_CHALLENGE_INVALID_JWT_FORMAT")
        })

        it("should return 400 when JWT signature is invalid", async () => {
          // Given: Generate valid challenge and create JWT with wrong signature
          const {nonce} = await generateChallengeAndGetPayload()

          // Create JWT with valid payload but tamper with it
          const validJwt = createJwtAssertion(nonce)
          const parts = validJwt.split(".")
          // Tamper with signature
          const tamperedJwt = `${parts[0]}.${parts[1]}.${Buffer.from("invalid-signature").toString("base64url")}`

          const jwtTokenRequest: JwtAssertionTokenRequest = {
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: tamperedJwt
          }

          // When
          const response = await supertest(app.getHttpServer()).post(tokenEndpoint).send(jwtTokenRequest)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("AGENT_CHALLENGE_INVALID_JWT_SIGNATURE")
        })

        it("should return 422 when JWT has expired", async () => {
          // Given: Generate valid challenge and create expired JWT
          const {nonce} = await generateChallengeAndGetPayload()
          const expiredJwt = createJwtAssertion(nonce, Math.floor(Date.now() / 1000) - 10) // 10 seconds ago

          const jwtTokenRequest: JwtAssertionTokenRequest = {
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: expiredJwt
          }

          // When
          const response = await supertest(app.getHttpServer()).post(tokenEndpoint).send(jwtTokenRequest)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.UNPROCESSABLE_ENTITY)
          expect(response.body).toHaveErrorCode("AGENT_CHALLENGE_JWT_EXPIRED")
        })

        it("should return 400 when challenge nonce does not exist", async () => {
          // Given: Valid JWT with non-existent nonce
          const nonExistentNonce = "non-existent-nonce-12345678901234567890123456789012"
          const jwtAssertion = createJwtAssertion(nonExistentNonce)

          const jwtTokenRequest: JwtAssertionTokenRequest = {
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: jwtAssertion
          }

          // When
          const response = await supertest(app.getHttpServer()).post(tokenEndpoint).send(jwtTokenRequest)

          // Expect
          expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
          expect(response.body).toHaveErrorCode("AGENT_CHALLENGE_NOT_FOUND")
        })
      })

      describe("good cases", () => {
        it("should exchange valid JWT assertion for JWT token", async () => {
          // Given: Generate valid challenge and create JWT assertion
          const {nonce} = await generateChallengeAndGetPayload()
          const jwtAssertion = createJwtAssertion(nonce)

          const jwtTokenRequest: JwtAssertionTokenRequest = {
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: jwtAssertion
          }

          // When
          const response = await supertest(app.getHttpServer()).post(tokenEndpoint).send(jwtTokenRequest)

          // Expect
          expect(response).toHaveStatusCode(200)
          expect(response.body).toHaveProperty("token")
          expect(typeof response.body.token).toBe("string")

          // Verify JWT token content
          const decodedToken = jwtService.decode(response.body.token) as Record<string, unknown>
          expect(decodedToken).toHaveProperty("sub", testAgent.agentName)
          expect(decodedToken).toHaveProperty("entityType", "agent")
          expect(decodedToken).toHaveProperty("name", testAgent.agentName)
          expect(decodedToken).toHaveProperty("iss", configProvider.jwtConfig.issuer)
          expect(decodedToken).toHaveProperty("aud", [configProvider.jwtConfig.audience])
          expect(decodedToken).not.toHaveProperty("email") // Agents don't have email

          // Verify challenge is marked as used in database
          const storedChallenge = await prisma.agentChallenge.findFirst({
            where: {nonce}
          })
          expect(storedChallenge).not.toBeNull()
          expect(storedChallenge?.usedAt).not.toBeNull()

          // Verify token can be used to authenticate
          const infoResponse = await supertest(app.getHttpServer())
            .get("/auth/info")
            .set("Authorization", `Bearer ${response.body.token}`)

          expect(infoResponse).toHaveStatusCode(200)
          expect(infoResponse.body).toHaveProperty("entityType", "agent")
        })

        it("should work by extracting agent name from JWT issuer claim", async () => {
          // Given: Generate valid challenge and create JWT assertion
          const {nonce} = await generateChallengeAndGetPayload()
          const jwtAssertion = createJwtAssertion(nonce)

          const jwtTokenRequest: JwtAssertionTokenRequest = {
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: jwtAssertion
            // Note: Agent name is extracted from JWT issuer claim automatically
          }

          // When
          const response = await supertest(app.getHttpServer()).post(tokenEndpoint).send(jwtTokenRequest)

          // Expect
          expect(response).toHaveStatusCode(200)
          expect(response.body).toHaveProperty("token")
          expect(typeof response.body.token).toBe("string")

          // Verify JWT token content matches
          const decodedToken = jwtService.decode(response.body.token) as Record<string, unknown>
          expect(decodedToken).toHaveProperty("name", testAgent.agentName)
        })
      })
    })
  })
})
