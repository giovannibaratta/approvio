import {Prisma, PrismaClient} from "@prisma/client"
import {PrismaPg} from "@prisma/adapter-pg"
import {randomOrgId} from "@test/organization-id"
import {MockConfigProvider} from "@test/mock-data"
import {
  ConflictingIsolationLevelError,
  DatabaseClient,
  TenantContextRequiredError
} from "../../src/database/database-client"
import {SpaceTenantClient} from "../../src/database/tenant-database-clients"
import {transactionContext} from "../../src/database/transaction-context"

describe("transaction isolation requirement", () => {
  const connection = "postgresql://test:test@localhost:1/isolation_test"
  const config = MockConfigProvider.fromTenantConnectionUrl(connection)
  const database = new DatabaseClient(config, "approvio_tenant_runtime")
  const workers = new DatabaseClient(config, "approvio_worker_runtime")
  const spaces = new SpaceTenantClient(database)

  const tx = new PrismaClient({adapter: new PrismaPg({connectionString: connection})})
  const organizationId = randomOrgId()

  afterAll(async () => {
    await database.onModuleDestroy()
    await workers.onModuleDestroy()
    await tx.$disconnect()
  })

  it("rejects an isolation requirement without an active transaction", () => {
    // When / Expect
    expect(() => spaces.assertIsolationLevel(Prisma.TransactionIsolationLevel.RepeatableRead)).toThrow(
      TenantContextRequiredError
    )
  })

  it.each([Prisma.TransactionIsolationLevel.RepeatableRead, Prisma.TransactionIsolationLevel.Serializable])(
    "accepts a %s transaction for a RepeatableRead requirement",
    isolationLevel => {
      // Given
      const context = {
        tx,
        scope: {type: "organization" as const, organizationId},
        client: database,
        isolationLevel,
        runtimeRole: database.runtimeRole
      }

      // When / Expect
      transactionContext.run(context, () => {
        expect(() => spaces.assertIsolationLevel(Prisma.TransactionIsolationLevel.RepeatableRead)).not.toThrow()
      })
    }
  )

  it("rejects ReadCommitted when RepeatableRead is required", () => {
    // Given: an explicit ReadCommitted context, matching DatabaseClient's default isolation level.
    const context = {
      tx,
      scope: {type: "organization" as const, organizationId},
      client: database,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      runtimeRole: database.runtimeRole
    }

    // When / Expect
    transactionContext.run(context, () => {
      expect(() => spaces.assertIsolationLevel(Prisma.TransactionIsolationLevel.RepeatableRead)).toThrow(
        ConflictingIsolationLevelError
      )
    })
  })

  it("rejects a transaction belonging to another runtime role", () => {
    // Given
    const context = {
      tx,
      scope: {type: "organization" as const, organizationId},
      client: workers,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      runtimeRole: workers.runtimeRole
    }

    // When / Expect
    transactionContext.run(context, () => {
      expect(() => spaces.assertIsolationLevel(Prisma.TransactionIsolationLevel.RepeatableRead)).toThrow(
        TenantContextRequiredError
      )
    })
  })
})
