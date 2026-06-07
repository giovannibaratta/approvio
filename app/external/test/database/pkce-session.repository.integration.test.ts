import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {DatabaseClient, PkceSessionDbRepository, KmsModule, ConfigModule} from "@external"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("PkceSessionDbRepository Integration", () => {
  let prisma: PrismaClient
  let repository: PkceSessionDbRepository

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule, KmsModule],
      providers: [PkceSessionDbRepository, DatabaseClient]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
      .compile()

    const dbClient = module.get(DatabaseClient)
    prisma = dbClient.prisma
    repository = module.get(PkceSessionDbRepository)

    await dbClient.onModuleInit()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
  })

  describe("storePkceData and retrievePkceData", () => {
    it("should encrypt the codeVerifier in the database but retrieve it decrypted", async () => {
      // Given
      const state = uuidv7()
      const codeVerifier = "my-super-secret-code-verifier-value"
      const pkceData = {
        codeVerifier,
        redirectUri: "http://localhost:3000/callback",
        oidcState: "oidc-state-value",
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
        "SELECT code_verifier FROM pkce_sessions WHERE state = $1",
        state
      )
      expect(rawSessions).toHaveLength(1)
      const rawSession = rawSessions[0]
      expect(rawSession).toBeDefined()
      const rawVerifier = rawSession!.code_verifier
      expect(rawVerifier).not.toBe(codeVerifier)
      // AWS Encryption SDK outputs base64 strings
      expect(rawVerifier).toMatch(/^[A-Za-z0-9+/=]+$/)
    })
  })
})
