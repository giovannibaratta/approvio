import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {ConfigProvider} from "@external/config"
import {DATABASE_RUNTIME_ROLE_TOKEN, DatabaseClient} from "../../src/database/database-client"
import {createFixturePrismaClient, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"

// Fixture creation uses the admin connection; every assertion connects as a real restricted login.
describe("Runtime schema-version boundary", () => {
  let connection: string
  let runtime: PrismaClient | undefined
  let module: TestingModule | undefined

  beforeAll(async () => {
    connection = await prepareDatabase()
  }, 30000)
  afterAll(() => dropPreparedDatabase(connection), 30000)

  beforeEach(() => {
    runtime = undefined
    module = undefined
  })

  afterEach(async () => {
    await runtime?.$disconnect()
    await module?.close()
  })

  it.each(["approvio_tenant", "approvio_platform", "approvio_worker"])(
    "allows %s to read only the version identifier",
    async login => {
      // Given
      const url = new URL(connection)
      url.username = login
      runtime = createFixturePrismaClient(url.toString())

      // When
      const version = await runtime.databasechangelog.aggregate({_max: {id: true}})

      // Expect
      // The restricted login can read the migration identifier needed during startup.
      expect(version._max.id).toMatch(/^\d{14}-/)

      // When
      const readAuthor = runtime.$queryRaw`SELECT author FROM public.databasechangelog`

      // Expect
      await expect(readAuthor).rejects.toThrow(/permission denied/)

      // When
      const readLock = runtime.$queryRaw`SELECT * FROM public.databasechangeloglock`

      // Expect
      await expect(readLock).rejects.toThrow(/permission denied/)
    }
  )

  it("starts the tenant database client with a non-owner login", async () => {
    // Given
    const url = new URL(connection)
    url.username = "approvio_tenant"
    module = await Test.createTestingModule({
      providers: [
        DatabaseClient,
        {provide: ConfigProvider, useValue: MockConfigProvider.fromTenantConnectionUrl(url.toString())},
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_tenant_runtime"}
      ]
    }).compile()
    // When
    const initialization = module.init()

    // Expect
    // Initialization connects and validates the schema version using the restricted tenant login.
    await expect(initialization).resolves.toBe(module)
  })
})
