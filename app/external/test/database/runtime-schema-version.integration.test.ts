import {DatabaseClient, REQUIRED_DB_MIGRATION_TIMESTAMP} from "../../src/database/database-client"
import {createFixturePrismaClient, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"

// Fixture creation uses the admin connection; every assertion connects as a real restricted login.
describe("Runtime schema-version boundary", () => {
  let connection: string
  beforeAll(async () => {
    connection = await prepareDatabase()
  }, 30000)
  afterAll(() => dropPreparedDatabase(connection), 30000)

  it.each(["approvio_tenant", "approvio_platform", "approvio_worker"])(
    "allows %s to read only the version identifier",
    async login => {
      const url = new URL(connection)
      url.username = login
      const runtime = createFixturePrismaClient(url.toString())
      try {
        const versions = await runtime.$queryRaw<Array<{id: string}>>`
          SELECT id FROM public.databasechangelog ORDER BY id DESC LIMIT 1
        `
        expect(versions).toHaveLength(1)
        expect(versions[0]?.id).toMatch(/^\d{14}-/)
        expect((versions[0]?.id.slice(0, 14) ?? "") >= REQUIRED_DB_MIGRATION_TIMESTAMP).toBe(true)
        await expect(runtime.$queryRaw`SELECT author FROM public.databasechangelog`).rejects.toThrow(
          /permission denied/
        )
        await expect(runtime.$queryRaw`SELECT * FROM public.databasechangeloglock`).rejects.toThrow(/permission denied/)
      } finally {
        await runtime.$disconnect()
      }
    }
  )

  it("starts the tenant database client with a non-owner login", async () => {
    const url = new URL(connection)
    url.username = "approvio_tenant"
    const database = new DatabaseClient(MockConfigProvider.fromTenantConnectionUrl(url.toString()))
    try {
      await database.onModuleInit()
      await expect(database.checkConnection()).resolves.toBeUndefined()
    } finally {
      await database.onModuleDestroy()
    }
  })
})
