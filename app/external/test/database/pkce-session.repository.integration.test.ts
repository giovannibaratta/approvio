import {PkceSessionDbRepository} from "@external/database/pkce-session.repository"
import {SessionDatabaseClient} from "@external/database/capability-database-client"
import {DatabaseClient} from "@external/database/database-client"
import {PlatformEncryptionService} from "@external/kms/context-bound-encryption.service"
import {EnvVarKmsProvider} from "@external/kms/env-var-kms.provider"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("PkceSessionDbRepository Integration", () => {
  let prisma: PrismaClient
  let repository: PkceSessionDbRepository
  let sessions: SessionDatabaseClient
  let database: DatabaseClient

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    database = new DatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: isolatedDb,
        platformConnectionUrl: isolatedDb,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    prisma = createFixturePrismaClient(isolatedDb)
    sessions = new SessionDatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: isolatedDb,
        platformConnectionUrl: isolatedDb,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    repository = new PkceSessionDbRepository(
      sessions,
      new PlatformEncryptionService(new EnvVarKmsProvider(new Map([[1, Buffer.alloc(32, 7)]]), 1))
    )

    await prisma.$connect()
    await sessions.onModuleInit()
  }, 30000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await sessions.onModuleDestroy()
    await database.onModuleDestroy()
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
})
