import {createMockOrganization} from "@test/mock-data"
import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {WORKER_DATABASE_CORE_TOKEN} from "@external/database/worker-database-core.token"
import {TENANT_OUTBOX_REPOSITORY_TOKEN, WORKER_OUTBOX_REPOSITORY_TOKEN} from "@services/durable-work/interfaces"
import {TRANSACTION_MANAGER_TOKEN, WORKER_TRANSACTION_MANAGER_TOKEN} from "@services/transaction/interfaces"
import {WorkerOutboxDbRepository} from "@external/database/worker-outbox.repository"
import {WorkerOutboxService} from "@services/durable-work/worker-outbox.service"
import {TenantOutboxService} from "@services/durable-work/tenant-outbox.service"
import {LeaseFactory, TenantEvent} from "@domain"
import {PrismaWorkerTransactionManager} from "@external/database/worker-transaction-manager"
import * as O from "fp-ts/Option"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {outboxRecoveryCriteria} from "@services/durable-work/tenant-outbox.utils"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {WorkerDatabaseClient} from "@external/database/capability-database-client"
import {DATABASE_RUNTIME_ROLE_TOKEN, DatabaseClient} from "@external/database/database-client"
import {TenantOutboxTenantClient, EventReceiptTenantClient} from "@external/database/tenant-database-clients"
import {EventReceiptDbRepository} from "@external/database/event-receipt.repository"
import {TenantOutboxDbRepository} from "@external/database/tenant-outbox.repository"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

// Exercise the public outbox services with real tenant and worker database capabilities.
describe("Outbox services integration", () => {
  let module: TestingModule
  let connectionString: string
  let prisma: PrismaClient
  let database: DatabaseClient
  let tenantService: TenantOutboxService
  let tenantTransactions: PrismaTransactionManager
  let workerTransactions: PrismaWorkerTransactionManager
  let workerOutbox: WorkerOutboxService
  let outbox: TenantOutboxDbRepository
  let organizationId: ReturnType<typeof toOrganizationId>

  beforeEach(async () => {
    connectionString = await prepareDatabase()
    const tenantUrl = new URL(connectionString)
    tenantUrl.username = "approvio_tenant"
    const workerUrl = new URL(connectionString)
    workerUrl.username = "approvio_worker"
    module = await Test.createTestingModule({
      providers: [
        DatabaseClient,
        TenantOutboxTenantClient,
        EventReceiptTenantClient,
        EventReceiptDbRepository,
        TenantOutboxDbRepository,
        WorkerOutboxDbRepository,
        PrismaTransactionManager,
        PrismaWorkerTransactionManager,
        TenantOutboxService,
        WorkerOutboxService,
        WorkerDatabaseClient,
        {
          provide: ConfigProvider,
          useValue: {
            databaseConfig: {
              tenantConnectionUrl: tenantUrl.toString(),
              platformConnectionUrl: connectionString,
              retry: {maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
            }
          }
        },
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_tenant_runtime"},
        {
          provide: WORKER_DATABASE_CORE_TOKEN,
          useFactory: () =>
            new DatabaseClient(
              {
                databaseConfig: {
                  tenantConnectionUrl: workerUrl.toString(),
                  platformConnectionUrl: connectionString,
                  retry: {maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
                }
              },
              "approvio_worker_runtime"
            )
        },
        {provide: TENANT_OUTBOX_REPOSITORY_TOKEN, useExisting: TenantOutboxDbRepository},
        {provide: WORKER_OUTBOX_REPOSITORY_TOKEN, useExisting: WorkerOutboxDbRepository},
        {provide: TRANSACTION_MANAGER_TOKEN, useExisting: PrismaTransactionManager},
        {provide: WORKER_TRANSACTION_MANAGER_TOKEN, useExisting: PrismaWorkerTransactionManager}
      ]
    }).compile()
    prisma = createFixturePrismaClient(connectionString)
    database = module.get(DatabaseClient)
    tenantService = module.get(TenantOutboxService)
    tenantTransactions = module.get(PrismaTransactionManager)
    workerTransactions = module.get(PrismaWorkerTransactionManager)
    workerOutbox = module.get(WorkerOutboxService)
    outbox = module.get(TenantOutboxDbRepository)
    organizationId = randomOrgId()
    await prisma.organization.create({data: createMockOrganization({id: organizationId})})
    await module.init()
  }, 30_000)

  afterEach(async () => {
    jest.restoreAllMocks()
    if (!prisma) return
    await prisma.$disconnect()
    await module.close()
    await dropPreparedDatabase(connectionString)
  })

  it("does not claim an eligible event from another organization", async () => {
    // Given
    const event = await appendEvent()
    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: createMockOrganization({id: otherOrganizationId})})
    const criteria = outboxRecoveryCriteria(uuidv7(), new Date(), 10)

    // When
    const foreign = await workerOutbox.claim({organizationId: otherOrganizationId}, criteria)()

    // Expect
    expect(foreign).toBeRightOf([])
    expect(
      await prisma.tenantOutbox.findUniqueOrThrow({
        where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
      })
    ).toMatchObject({attempts: 0n, leaseOwner: null})

    // When
    const local = await workerOutbox.claim({organizationId}, criteria)()

    // Expect: The event was eligible; it was excluded from the foreign tenant's claim.
    expect(unwrapRight(local)).toHaveLength(1)
  })

  async function appendEvent() {
    const context = {organizationId}
    const event: TenantEvent = {
      organizationId,
      schemaVersion: 1 as const,
      eventId: uuidv7(),
      type: "workflow.recalculate" as const,
      workflowId: uuidv7()
    }
    unwrapRight(
      await database.transactional({type: "organization", organizationId}, () => tenantService.append(context, event)())
    )
    await prisma.tenantOutbox.updateMany({
      where: {organizationId, eventId: event.eventId},
      data: {createdAt: new Date(Date.now() - 11 * 60_000)}
    })
    return event
  }

  it.each([0n, -1n, 9_223_372_036_854_775_808n])(
    "rejects acknowledgement with an unowned fencing value %s",
    async fencing => {
      // Given
      const event = await appendEvent()
      const context = {organizationId}
      const [claim] = unwrapRight(
        await workerTransactions.execute(context, () =>
          workerOutbox.claim(context, outboxRecoveryCriteria(uuidv7(), new Date(), 10))
        )()
      )
      if (!claim) throw new Error("Outbox fixture omitted its claim")
      const lease = unwrapRight(LeaseFactory.validate({...claim.lease, fencing}))

      // When
      const result = await workerOutbox.acknowledge(context, event.eventId, lease)()

      // Expect
      expect(result).toBeLeftOf("lease_lost")
      expect(
        await prisma.tenantOutbox.findUniqueOrThrow({
          where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
        })
      ).toMatchObject({attempts: 1n, publishedAt: null, leaseOwner: claim.lease.owner})
    }
  )

  it("accepts concurrent identical appends without creating a second row", async () => {
    // Given
    const context = {organizationId}
    const event: TenantEvent = {
      organizationId,
      schemaVersion: 1,
      eventId: uuidv7(),
      type: "workflow.recalculate",
      workflowId: uuidv7()
    }

    // When
    const results = await Promise.all([
      tenantTransactions.execute(context, () => tenantService.append(context, event))(),
      tenantTransactions.execute(context, () => tenantService.append(context, event))()
    ])

    // Expect
    expect(results[0]).toBeRightOf(undefined)
    expect(results[1]).toBeRightOf(undefined)
    expect(await prisma.tenantOutbox.count({where: {organizationId}})).toBe(1)
  })

  it("rejects duplicate IDs with different payload data even when envelope fields match", async () => {
    // Given
    const context = {organizationId}
    const event: TenantEvent = {
      organizationId,
      schemaVersion: 1,
      eventId: uuidv7(),
      type: "task.ready",
      taskId: uuidv7(),
      taskOcc: 1n,
      taskKind: "email"
    }
    const availableAt = new Date(Date.now() + 60_000)
    unwrapRight(await tenantTransactions.execute(context, () => tenantService.append(context, event, availableAt))())
    const before = await prisma.tenantOutbox.findUniqueOrThrow({
      where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
    })

    // When
    const result = await tenantTransactions.execute(context, () =>
      tenantService.append(context, {...event, taskKind: "slack"})
    )()

    // Expect: The same ID must not overwrite a different task kind or its publication schedule.
    expect(result).toBeLeftOf("event_mismatch")
    expect(
      await prisma.tenantOutbox.findUniqueOrThrow({
        where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
      })
    ).toEqual(before)
  })

  it("rejects an organization mismatch before attempting an insert", async () => {
    // Given
    const context = {organizationId}
    const event: TenantEvent = {
      organizationId,
      schemaVersion: 1,
      eventId: uuidv7(),
      type: "workflow.recalculate",
      workflowId: uuidv7()
    }

    // When
    const result = await tenantTransactions.execute(context, () =>
      tenantService.append(context, {...event, organizationId: randomOrgId()})
    )()

    // Expect
    expect(result).toBeLeftOf("organization_mismatch")
    expect(await prisma.tenantOutbox.count({where: {organizationId}})).toBe(0)
  })

  it("preserves an expired worker lease when a tenant marks publication", async () => {
    // Given
    const context = {organizationId}
    const event = await appendEvent()
    const owner = uuidv7()
    const expiresAt = new Date(Date.now() - 1_000)
    await prisma.tenantOutbox.updateMany({
      where: {organizationId, eventId: event.eventId},
      data: {leaseOwner: owner, leaseUntil: expiresAt}
    })

    // When
    const state = await tenantTransactions.execute(context, () => outbox.getPublicationState(context, event.eventId))()

    // Expect
    expect(state).toBeRightOf(O.some({state: "leased", owner, expiresAt}))

    // When
    const result = await tenantService.markPublished(context, event.eventId)()

    // Expect: Only the worker acknowledgement can complete publication of a leased row.
    expect(result).toBeRightOf(undefined)
    expect(
      await prisma.tenantOutbox.findUniqueOrThrow({
        where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
      })
    ).toMatchObject({publishedAt: null, leaseOwner: owner, leaseUntil: expiresAt})
  })

  it("rejects publication when lease ownership has no expiry", async () => {
    // Given: A deliberately corrupted row has only one of the lease columns populated.
    const context = {organizationId}
    const event = await appendEvent()
    await prisma.tenantOutbox.updateMany({
      where: {organizationId, eventId: event.eventId},
      data: {leaseOwner: uuidv7(), leaseUntil: null}
    })

    // When
    const result = await tenantService.markPublished(context, event.eventId)()

    // Expect
    expect(result).toBeLeftOf("outbox_publication_state_invalid")
  })

  it("reports a missing event without creating a publication", async () => {
    // Given
    const context = {organizationId}
    const eventId = uuidv7()

    // When
    const state = await tenantTransactions.execute(context, () => outbox.getPublicationState(context, eventId))()

    // Expect
    expect(state).toBeRightOf(O.none)

    // When
    const result = await tenantService.markPublished(context, eventId)()

    // Expect
    expect(result).toBeLeftOf("event_not_found")
    expect(await prisma.tenantOutbox.count()).toBe(0)
  })

  it("preserves the first publication timestamp on repeated publication", async () => {
    // Given
    const context = {organizationId}
    const event = await appendEvent()
    unwrapRight(await tenantService.markPublished(context, event.eventId)())
    const before = await prisma.tenantOutbox.findUniqueOrThrow({
      where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
    })

    // When
    const result = await tenantService.markPublished(context, event.eventId)()

    // Expect
    expect(result).toBeRightOf(undefined)
    expect(before.publishedAt).toEqual(expect.any(Date))
    expect(
      await prisma.tenantOutbox.findUniqueOrThrow({
        where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
      })
    ).toEqual(before)
  })

  it("does not publish another organization's event", async () => {
    // Given
    const event = await appendEvent()
    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: createMockOrganization({id: otherOrganizationId})})
    const before = await prisma.tenantOutbox.findUniqueOrThrow({
      where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
    })

    // When
    const result = await tenantService.markPublished({organizationId: otherOrganizationId}, event.eventId)()

    // Expect
    expect(result).toBeLeftOf("event_not_found")
    expect(
      await prisma.tenantOutbox.findUniqueOrThrow({
        where: {organizationId_eventId: {organizationId, eventId: event.eventId}}
      })
    ).toEqual(before)
  })
})
