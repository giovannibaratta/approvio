import {ConfigModule, KmsModule} from "@external"
import {MockConfigProvider} from "@test/mock-data"
import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {PkceSessionDbRepository} from "@external/database/pkce-session.repository"
import {SessionDatabaseClient} from "@external/database/capability-database-client"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("PkceSessionDbRepository Integration", () => {
  let prisma: PrismaClient
  let repository: PkceSessionDbRepository
  let module: TestingModule

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    module = await Test.createTestingModule({
      imports: [ConfigModule, KmsModule],
      providers: [PkceSessionDbRepository, SessionDatabaseClient]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromOriginalProvider({tenantConnectionUrl: isolatedDb}))
      .compile()
    prisma = createFixturePrismaClient(isolatedDb)
    repository = module.get(PkceSessionDbRepository)
    await module.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await module.close()
  })

  describe("storePkceData and retrievePkceData", () => {
    it("should encrypt the codeVerifier in the database but retrieve it decrypted", async () => {
      // Given
      const state = uuidv7()
      const providerId = "custom"
      const codeVerifier = "my-super-secret-code-verifier-value"
      const pkceData = {
        codeVerifier,
        redirectUri: "http://localhost:3000/callback",
        oidcState: "oidc-state-value",
        providerId,
        flow: "initial_login" as const,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 100000)
      }

      // When: We store the PKCE data using the repository
      const storeResult = await repository.storePkceData(state, pkceData)()
      expect(storeResult).toBeRight()

      // Then: Querying via repository retrieves the DECRYPTED value
      const retrieveResult = await repository.retrievePkceData(state)()
      expect(retrieveResult).toBeRight()
      const retrieved = unwrapRight(retrieveResult)
      expect(retrieved.codeVerifier).toBe(codeVerifier)

      // And: Querying the database directly via raw SQL (bypassing extensions) retrieves the ENCRYPTED value
      const rawSessions = await prisma.$queryRawUnsafe<Record<string, string>[]>(
        "SELECT enc_code_verifier FROM pkce_sessions WHERE state = $1",
        state
      )
      expect(rawSessions).toHaveLength(1)
      const rawSession = rawSessions[0]
      expect(rawSession).toBeDefined()
      const rawVerifier = rawSession!.enc_code_verifier
      expect(rawVerifier).not.toBe(codeVerifier)
      expect(rawVerifier).toMatch(/^approvio:enc:v1:/)
    })
  })

  it.each([
    {storedData: {encCodeVerifier: "invalid-ciphertext"}, error: "unsupported_format"},
    {storedData: {providerId: "different-provider"}, error: "ciphertext_context_mismatch"}
  ])("preserves $error when decrypting a stored session", async ({storedData, error}) => {
    // Given
    const state = uuidv7()
    const data = {
      codeVerifier: "code-verifier",
      redirectUri: "https://example.com/callback",
      oidcState: "oidc-state",
      providerId: "custom",
      flow: "initial_login" as const,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 100000)
    }

    // When
    unwrapRight(await repository.storePkceData(state, data)())
    await prisma.pkceSession.update({where: {state}, data: storedData})
    const result = await repository.retrievePkceData(state)()

    // Expect
    expect(result).toBeLeftOf(error)
  })
})
