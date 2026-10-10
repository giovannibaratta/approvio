import {PrismaWorkerTransactionManager} from "@external/database/worker-transaction-manager"
import {TenantOutboxService} from "@services/durable-work/tenant-outbox.service"
import {toOrganizationId} from "@test/organization-id"
import {DatabaseClient, OrganizationMismatchError} from "@external/database/database-client"
import {WorkerDatabaseClient} from "@external/database/capability-database-client"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {EventReceiptTenantClient, TenantOutboxTenantClient} from "@external/database/tenant-database-clients"
import {EventReceiptDbRepository} from "@external/database/event-receipt.repository"
import {TenantOutboxDbRepository} from "@external/database/tenant-outbox.repository"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {seedTwoOrganizationFixture} from "@test/tenancy"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {v7 as uuidv7} from "uuid"

describe("EventReceiptDbRepository integration", () => {
  let isolatedDb: string
  let database: DatabaseClient
  let workers: WorkerDatabaseClient
  let prisma: PrismaClient
  let transactionManager: PrismaTransactionManager
  let receipts: EventReceiptDbRepository
  let outbox: TenantOutboxDbRepository
  let organizationId: ReturnType<typeof toOrganizationId>
  let otherOrganizationId: ReturnType<typeof toOrganizationId>

  beforeAll(async () => {
    isolatedDb = await prepareDatabase()
    const config = {
      databaseConfig: {
        tenantConnectionUrl: isolatedDb,
        platformConnectionUrl: isolatedDb,
        poolSize: 2,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    }
    database = new DatabaseClient(config)
    workers = new WorkerDatabaseClient(config)
    prisma = createFixturePrismaClient(isolatedDb)
    transactionManager = new PrismaTransactionManager(database)
    receipts = new EventReceiptDbRepository(new EventReceiptTenantClient(database))
    outbox = new TenantOutboxDbRepository(new TenantOutboxTenantClient(database), workers)
    await database.onModuleInit()
    const fixture = await seedTwoOrganizationFixture(prisma)
    organizationId = fixture.organizationA.id
    otherOrganizationId = fixture.organizationB.id
  }, 30_000)

  afterAll(async () => {
    if (!isolatedDb || !database || !workers || !prisma) return
    await database.onModuleDestroy()
    await workers.onModuleDestroy()
    await prisma.$disconnect()
    await dropPreparedDatabase(isolatedDb)
  }, 30_000)

  it("records a receipt once and rolls it back with failed consumer work", async () => {
    const context = {organizationId}
    const eventId = uuidv7()
    const event = {
      organizationId,
      schemaVersion: 1 as const,
      eventId,
      type: "workflow.recalculate" as const,
      workflowId: uuidv7()
    }
    expect(
      await database.transactional(organizationId, () =>
        new TenantOutboxService(outbox, new PrismaWorkerTransactionManager(workers)).append(context, event)()
      )
    ).toEqual(E.right(undefined))

    const first = await transactionManager.execute(context, () => receipts.record(context, "recalculation", eventId))()
    const duplicate = await transactionManager.execute(context, () =>
      receipts.record(context, "recalculation", eventId)
    )()
    expect(first).toEqual(E.right("new"))
    expect(duplicate).toEqual(E.right("duplicate"))

    const rollbackEventId = uuidv7()
    const rollbackEvent = {...event, eventId: rollbackEventId}
    expect(
      await database.transactional(organizationId, () =>
        new TenantOutboxService(outbox, new PrismaWorkerTransactionManager(workers)).append(context, rollbackEvent)()
      )
    ).toEqual(E.right(undefined))
    const rolledBack = await transactionManager.execute(context, () =>
      pipe(
        receipts.record(context, "recalculation", rollbackEventId),
        TE.chainW(() => TE.left("consumer_failed" as const))
      )
    )()
    expect(rolledBack).toEqual(E.left("consumer_failed"))

    const rows = await prisma.$queryRaw<Array<{readonly count: bigint}>>`
      SELECT COUNT(*) AS count FROM tenant_event_receipts
      WHERE organization_id = ${organizationId}::uuid AND event_id = ${rollbackEventId}::uuid
    `
    expect(rows[0]?.count).toBe(0n)
  })

  it("rejects a receipt for an event that is not in the tenant outbox", async () => {
    const context = {organizationId}
    const result = await transactionManager.execute(context, () =>
      receipts.record(context, "recalculation", uuidv7())
    )()
    expect(result).toEqual(E.left("event_mismatch"))
  })

  it("records one receipt when two transactions process the same event concurrently", async () => {
    // Given: both consumers reference the same committed event.
    const context = {organizationId}
    const eventId = uuidv7()
    const event = {
      organizationId,
      schemaVersion: 1 as const,
      eventId,
      type: "workflow.recalculate" as const,
      workflowId: uuidv7()
    }
    expect(
      await database.transactional(organizationId, () =>
        new TenantOutboxService(outbox, new PrismaWorkerTransactionManager(workers)).append(context, event)()
      )
    ).toEqual(E.right(undefined))

    // When: two independent transactions attempt the insert without a receipt pre-check.
    const results = await Promise.all([
      transactionManager.execute(context, () => receipts.record(context, "recalculation", eventId))(),
      transactionManager.execute(context, () => receipts.record(context, "recalculation", eventId))()
    ])

    // Expect: one insert and one duplicate; both transactions commit successfully.
    expect(results).toEqual(expect.arrayContaining([E.right("new"), E.right("duplicate")]))
    expect(await prisma.tenantEventReceipt.count({where: {organizationId, eventId}})).toBe(1)
  })

  it("rejects a tenant change at both transaction boundaries before inserting a receipt", async () => {
    // Given: an event exists only in the other organization.
    const eventId = uuidv7()
    const event = {
      organizationId: otherOrganizationId,
      schemaVersion: 1 as const,
      eventId,
      type: "workflow.recalculate" as const,
      workflowId: uuidv7()
    }
    expect(
      await database.transactional(otherOrganizationId, () =>
        new TenantOutboxService(outbox, new PrismaWorkerTransactionManager(workers)).append(
          {organizationId: otherOrganizationId},
          event
        )()
      )
    ).toEqual(E.right(undefined))

    // When: receipt work requests a different tenant inside an existing transaction.
    const tenantClient = new EventReceiptTenantClient(database)
    const tenantRequest = database.transactional(organizationId, () =>
      tenantClient.transactional(otherOrganizationId, cx => cx.record("recalculation", eventId))
    )
    await expect(tenantRequest).rejects.toBeInstanceOf(OrganizationMismatchError)

    const workerRequest = workers.transactional(organizationId, () =>
      workers.transactional(otherOrganizationId, cx => cx.eventReceipts.record("recalculation", eventId))
    )

    // Expect: neither transaction can change tenants or consume the other organization's event.
    await expect(workerRequest).rejects.toBeInstanceOf(OrganizationMismatchError)
    expect(await prisma.tenantEventReceipt.count({where: {eventId}})).toBe(0)
  })
})
