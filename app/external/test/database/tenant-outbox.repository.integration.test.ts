import {TenantOutboxService} from "@services/durable-work/tenant-outbox.service"
import {LeaseFactory} from "@domain"
import {PrismaWorkerTransactionManager} from "@external/database/worker-transaction-manager"
import * as O from "fp-ts/Option"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {outboxRecoveryCriteria} from "@services/durable-work/tenant-outbox.utils"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {WorkerDatabaseClient} from "@external/database/capability-database-client"
import {DatabaseClient} from "@external/database/database-client"
import {TenantOutboxTenantClient} from "@external/database/tenant-database-clients"
import {TenantOutboxDbRepository} from "@external/database/tenant-outbox.repository"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

// Checks append idempotency and scoped lease ownership independently of relay scheduling.
describe("TenantOutboxDbRepository tenant boundary", () => {
  let connectionString: string
  let prisma: PrismaClient
  let database: DatabaseClient
  let workers: WorkerDatabaseClient
  let workerTransactions: PrismaWorkerTransactionManager
  let outbox: TenantOutboxDbRepository
  let organizationId: ReturnType<typeof toOrganizationId>

  beforeEach(async () => {
    connectionString = await prepareDatabase()
    database = new DatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connectionString,
        platformConnectionUrl: connectionString,
        retry: {maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    prisma = createFixturePrismaClient(connectionString)
    workers = new WorkerDatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connectionString,
        platformConnectionUrl: connectionString,
        retry: {maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    workerTransactions = new PrismaWorkerTransactionManager(workers)
    outbox = new TenantOutboxDbRepository(new TenantOutboxTenantClient(database), workers)
    organizationId = randomOrgId()
    await prisma.organization.create({data: organization(organizationId)})
    await workers.onModuleInit()
  }, 30_000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await workers.onModuleDestroy()
    await database.onModuleDestroy()
    await dropPreparedDatabase(connectionString)
  })

  it("keeps event identity tenant-bound across append, claim and acknowledgement", async () => {
    const context = {organizationId}
    const event = {
      organizationId,
      schemaVersion: 1 as const,
      eventId: uuidv7(),
      type: "workflow.recalculate" as const,
      workflowId: uuidv7()
    }
    unwrapRight(
      await database.transactional(organizationId, () =>
        new TenantOutboxService(outbox, workerTransactions).append(context, event)()
      )
    )
    unwrapRight(
      await database.transactional(organizationId, () =>
        new TenantOutboxService(outbox, workerTransactions).append(context, event)()
      )
    )

    const early = unwrapRight(
      await workerTransactions.execute(context, () =>
        outbox.claim(context, outboxRecoveryCriteria(uuidv7(), new Date(), 10))
      )()
    )
    expect(early).toEqual([])

    const recoveryTime = new Date(Date.now() + 11 * 60_000)
    const claimed = unwrapRight(
      await workerTransactions.execute(context, () =>
        outbox.claim(context, outboxRecoveryCriteria(uuidv7(), recoveryTime, 10))
      )()
    )
    expect(claimed).toHaveLength(1)
    unwrapRight(
      await new TenantOutboxService(outbox, workerTransactions).acknowledge(context, event.eventId, claimed[0]!.lease)()
    )

    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: organization(otherOrganizationId)})
    const foreign = unwrapRight(
      await workerTransactions.execute({organizationId: otherOrganizationId}, () =>
        outbox.claim({organizationId: otherOrganizationId}, outboxRecoveryCriteria(uuidv7(), new Date(), 10))
      )()
    )
    expect(foreign).toEqual([])
  })
  async function appendEvent() {
    const context = {organizationId}
    const event = {
      organizationId,
      schemaVersion: 1 as const,
      eventId: uuidv7(),
      type: "workflow.recalculate" as const,
      workflowId: uuidv7()
    }
    unwrapRight(
      await database.transactional(organizationId, () =>
        new TenantOutboxService(outbox, workerTransactions).append(context, event)()
      )
    )
    await prisma.tenantOutbox.updateMany({
      where: {organizationId, eventId: event.eventId},
      data: {createdAt: new Date(Date.now() - 11 * 60_000)}
    })
    return event
  }

  it("claims an event once across competing relays and fences an expired owner", async () => {
    const event = await appendEvent()
    const context = {organizationId}
    const now = new Date()
    const results = await Promise.all([
      workerTransactions.execute(context, () => outbox.claim(context, outboxRecoveryCriteria(uuidv7(), now, 10)))(),
      workerTransactions.execute(context, () => outbox.claim(context, outboxRecoveryCriteria(uuidv7(), now, 10)))()
    ])
    const claims = results.flatMap(result => unwrapRight(result))
    expect(claims).toHaveLength(1)
    const first = claims[0]!
    await prisma.tenantOutbox.updateMany({where: {organizationId}, data: {leaseUntil: new Date(0)}})
    const reclaimed = unwrapRight(
      await workerTransactions.execute(context, () =>
        outbox.claim(context, outboxRecoveryCriteria(uuidv7(), new Date(), 10))
      )()
    )
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]!.lease.fencing).toBe(first.lease.fencing + 1n)
    expect(
      await new TenantOutboxService(outbox, workerTransactions).acknowledge(context, event.eventId, first.lease)()
    ).toBeLeftOf("lease_lost")
    unwrapRight(
      await new TenantOutboxService(outbox, workerTransactions).acknowledge(
        context,
        event.eventId,
        reclaimed[0]!.lease
      )()
    )
    expect(
      await new TenantOutboxService(outbox, workerTransactions).acknowledge(context, event.eventId, first.lease)()
    ).toBeLeftOf("lease_lost")
    expect(
      await new TenantOutboxService(outbox, workerTransactions).acknowledge(
        context,
        event.eventId,
        reclaimed[0]!.lease
      )()
    ).toBeLeftOf("lease_lost")
  })

  it.each([2_147_483_648n, 9_007_199_254_740_993n])(
    "rejects fencing %s outside the persisted counter range",
    async fencing => {
      const event = await appendEvent()
      const context = {organizationId}
      const [claim] = unwrapRight(
        await workerTransactions.execute(context, () =>
          outbox.claim(context, outboxRecoveryCriteria(uuidv7(), new Date(), 10))
        )()
      )
      if (!claim) throw new Error("Outbox fixture omitted its claim")
      const lease = unwrapRight(LeaseFactory.validate({...claim.lease, fencing}))

      expect(
        await new TenantOutboxService(outbox, workerTransactions).acknowledge(context, event.eventId, lease)()
      ).toBeLeftOf("lease_invalid_fencing")
      expect(
        await prisma.tenantOutbox.findUniqueOrThrow({
          where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
        })
      ).toMatchObject({attempts: 1, publishedAt: null, leaseOwner: claim.lease.owner})
    }
  )

  it("rolls back claim ownership when a persisted event cannot be decoded", async () => {
    const validEvent = await appendEvent()
    const event = await appendEvent()
    await prisma.tenantOutbox.updateMany({where: {organizationId, eventId: event.eventId}, data: {payload: {}}})

    expect(
      await workerTransactions.execute({organizationId}, () =>
        outbox.claim({organizationId}, outboxRecoveryCriteria(uuidv7(), new Date(), 10))
      )()
    ).toBeLeftOf("tenant_event_organization_id_invalid")
    const rows = await prisma.tenantOutbox.findMany({
      where: {organizationId, eventId: {in: [validEvent.eventId, event.eventId]}}
    })
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toMatchObject({attempts: 0, leaseOwner: null, leaseUntil: null})
  })

  it("accepts concurrent identical appends without creating a second row", async () => {
    const context = {organizationId}
    const event = {
      organizationId,
      schemaVersion: 1,
      eventId: uuidv7(),
      type: "workflow.recalculate",
      workflowId: uuidv7()
    }
    const transactions = new PrismaTransactionManager(database)

    const results = await Promise.all([
      transactions.execute(context, () => new TenantOutboxService(outbox, workerTransactions).append(context, event))(),
      transactions.execute(context, () => new TenantOutboxService(outbox, workerTransactions).append(context, event))()
    ])

    for (const result of results) expect(result).toBeRightOf(undefined)
    expect(await prisma.tenantOutbox.count({where: {organizationId}})).toBe(1)
  })

  it("rejects duplicate IDs with different payload data even when envelope fields match", async () => {
    const context = {organizationId}
    const event = {
      organizationId,
      schemaVersion: 1,
      eventId: uuidv7(),
      type: "task.ready",
      taskId: uuidv7(),
      taskOcc: 1n,
      taskKind: "email"
    }
    const transactions = new PrismaTransactionManager(database)
    const beforeAppend = new Date()
    const availableAt = new Date(Date.now() + 60_000)
    unwrapRight(
      await transactions.execute(context, () =>
        new TenantOutboxService(outbox, workerTransactions).append(context, event, availableAt)
      )()
    )
    const inserted = await prisma.tenantOutbox.findUniqueOrThrow({
      where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
    })
    const createdAt = inserted.createdAt
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(beforeAppend.getTime())
    expect(createdAt.getTime()).toBeLessThanOrEqual(Date.now())
    unwrapRight(
      await transactions.execute(context, () =>
        new TenantOutboxService(outbox, workerTransactions).append(context, event)
      )()
    )

    expect(
      await transactions.execute(context, () =>
        new TenantOutboxService(outbox, workerTransactions).append(context, {...event, taskKind: "slack"})
      )()
    ).toBeLeftOf("event_mismatch")
    expect(
      await prisma.tenantOutbox.findUniqueOrThrow({
        where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
      })
    ).toMatchObject({createdAt, availableAt, attempts: 0, payload: {taskKind: "email"}})
  })

  it("returns factory and organization errors before attempting an insert", async () => {
    const transactions = new PrismaTransactionManager(database)
    const context = {organizationId}
    const event = {
      organizationId,
      schemaVersion: 1,
      eventId: uuidv7(),
      type: "workflow.recalculate",
      workflowId: uuidv7()
    }
    expect(
      await transactions.execute(context, () =>
        new TenantOutboxService(outbox, workerTransactions).append(context, {...event, schemaVersion: 2})
      )()
    ).toBeLeftOf("tenant_event_schema_version_invalid")
    expect(
      await transactions.execute(context, () =>
        new TenantOutboxService(outbox, workerTransactions).append(context, {...event, organizationId: randomOrgId()})
      )()
    ).toBeLeftOf("organization_mismatch")
    expect(await prisma.tenantOutbox.count({where: {organizationId}})).toBe(0)
  })

  async function forceSerializationFailure(operation: "INSERT" | "UPDATE") {
    // This trigger exists only in the disposable database and raises PostgreSQL's real retryable error.
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION public.fail_outbox_serialization() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Forced outbox serialization failure' USING ERRCODE = '40001';
      END
      $$
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_outbox_serialization BEFORE ${operation} ON public.tenant_outbox
      FOR EACH ROW EXECUTE FUNCTION public.fail_outbox_serialization()
    `)
  }

  it("returns a Left to the service after the enclosing outbox transaction exhausts retries", async () => {
    const event = await appendEvent()
    await forceSerializationFailure("INSERT")
    const transactions = new PrismaTransactionManager(database)
    let attempts = 0

    const result = await transactions.execute({organizationId}, () => {
      attempts++
      return pipe(
        outbox.getEvent({organizationId}, event.eventId),
        TE.chainW(stored => new TenantOutboxService(outbox, workerTransactions).append({organizationId}, stored))
      )
    })()

    expect(result).toBeLeftOf("retry_exhausted")
    expect(attempts).toBe(3)
    expect(await prisma.tenantOutbox.count({where: {organizationId}})).toBe(1)
  })

  it.each(["claim", "publication", "acknowledge"] as const)(
    "returns a Left when the repository-owned %s transaction exhausts retries",
    async operation => {
      const event = await appendEvent()
      const context = {organizationId}
      const [claim] = unwrapRight(
        await workerTransactions.execute(context, () =>
          outbox.claim(context, outboxRecoveryCriteria(uuidv7(), new Date(), 10))
        )()
      )
      if (!claim) throw new Error("Outbox fixture omitted its claim")
      if (operation === "claim")
        await prisma.tenantOutbox.updateMany({where: {organizationId}, data: {leaseUntil: new Date(0)}})
      if (operation === "publication")
        await prisma.tenantOutbox.updateMany({where: {organizationId}, data: {leaseOwner: null, leaseUntil: null}})
      await forceSerializationFailure("UPDATE")

      const result =
        operation === "claim"
          ? await workerTransactions.execute(context, () =>
              outbox.claim(context, outboxRecoveryCriteria(uuidv7(), new Date(), 10))
            )()
          : operation === "publication"
            ? await new TenantOutboxService(outbox, workerTransactions).markPublished(context, event.eventId)()
            : await new TenantOutboxService(outbox, workerTransactions).acknowledge(
                context,
                event.eventId,
                claim.lease
              )()

      expect(result).toBeLeftOf("retry_exhausted")
      expect(
        await prisma.tenantOutbox.findUniqueOrThrow({
          where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
        })
      ).toMatchObject({attempts: 1, publishedAt: null})
    }
  )

  it("rolls back publication when the service-owned worker transaction returns a Left", async () => {
    const event = await appendEvent()
    const context = {organizationId}
    const tryMarkPublished = outbox.tryMarkPublished.bind(outbox)
    const write = jest.spyOn(outbox, "tryMarkPublished").mockImplementation((context, eventId, publishedAt) =>
      pipe(
        tryMarkPublished(context, eventId, publishedAt),
        TE.chainW(() => TE.left("event_mismatch" as const))
      )
    )
    try {
      const result = await new TenantOutboxService(outbox, workerTransactions).markPublished(context, event.eventId)()

      expect(result).toBeLeftOf("event_mismatch")
      expect(
        await prisma.tenantOutbox.findUniqueOrThrow({
          where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
        })
      ).toMatchObject({publishedAt: null, leaseOwner: null, attempts: 0})
    } finally {
      write.mockRestore()
    }
  })

  it("represents expired leases and rejects inconsistent publication columns", async () => {
    const context = {organizationId}
    const event = await appendEvent()
    const owner = uuidv7()
    const expiresAt = new Date(Date.now() - 1_000)
    await prisma.tenantOutbox.updateMany({
      where: {organizationId, eventId: event.eventId},
      data: {leaseOwner: owner, leaseUntil: expiresAt}
    })
    expect(
      await workerTransactions.execute(context, () => outbox.getPublicationState(context, event.eventId))()
    ).toBeRightOf(O.some({state: "leased", owner, expiresAt}))
    expect(
      await new TenantOutboxService(outbox, workerTransactions).markPublished(context, event.eventId)()
    ).toBeRightOf(undefined)
    expect(
      await prisma.tenantOutbox.findUniqueOrThrow({
        where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
      })
    ).toMatchObject({publishedAt: null, leaseOwner: owner, leaseUntil: expiresAt})
    await prisma.tenantOutbox.updateMany({where: {organizationId, eventId: event.eventId}, data: {leaseUntil: null}})
    expect(
      await new TenantOutboxService(outbox, workerTransactions).markPublished(context, event.eventId)()
    ).toBeLeftOf("outbox_publication_state_invalid")
  })

  it("reports missing publication and preserves the first publication timestamp", async () => {
    const context = {organizationId}
    expect(
      await workerTransactions.execute(context, () => outbox.getPublicationState(context, uuidv7()))()
    ).toBeRightOf(O.none)
    expect(await new TenantOutboxService(outbox, workerTransactions).markPublished(context, uuidv7())()).toBeLeftOf(
      "event_mismatch"
    )
    const event = await appendEvent()
    expect(
      await workerTransactions.execute(context, () => outbox.getPublicationState(context, event.eventId))()
    ).toBeRightOf(O.some({state: "pending"}))
    const publishedAt = new Date()
    unwrapRight(
      await new TenantOutboxService(outbox, workerTransactions).markPublished(context, event.eventId, publishedAt)()
    )
    unwrapRight(
      await new TenantOutboxService(outbox, workerTransactions).markPublished(
        context,
        event.eventId,
        new Date(publishedAt.getTime() + 1000)
      )()
    )
    expect(
      await workerTransactions.execute(context, () => outbox.getPublicationState(context, event.eventId))()
    ).toBeRightOf(O.some({state: "published", publishedAt}))
    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: organization(otherOrganizationId)})
    expect(
      await new TenantOutboxService(outbox, workerTransactions).markPublished(
        {organizationId: otherOrganizationId},
        event.eventId
      )()
    ).toBeLeftOf("event_mismatch")
  })
})

function organization(id: string) {
  const now = new Date()
  return {
    id,
    slug: `test-${id}`,
    displayName: "Test organization",
    planTier: "FREE",
    status: "active",
    occ: 0n,
    createdAt: now,
    updatedAt: now
  }
}
