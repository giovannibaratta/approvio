import {EventReceiptService} from "@services/durable-work/event-receipt.service"
import {DatabaseClient} from "@external/database/database-client"
import {TenantOutboxTenantClient, EventReceiptTenantClient} from "@external/database/tenant-database-clients"
import {TenantOutboxDbRepository} from "@external/database/tenant-outbox.repository"
import {EventReceiptDbRepository} from "@external/database/event-receipt.repository"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {TenantOutboxService} from "@services/durable-work/tenant-outbox.service"
import {wrapTaskEitherWithSideEffect} from "@test/injectors"
import {WorkerOutboxService} from "@services/durable-work/worker-outbox.service"
import {WorkflowStatus, TenantEvent} from "@domain"
import {mapToJsonValue} from "@external/database/shared/json-mappers"
import {unwrapRight} from "@utils/either"
import {LeaseFactory} from "@domain"
import {getQueueToken} from "@nestjs/bull"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {Queue} from "bull"
import {ConfigProvider} from "@external/config"
import {
  WORKFLOW_ACTION_EMAIL_QUEUE,
  WORKFLOW_STATUS_CHANGED_QUEUE,
  WORKFLOW_STATUS_RECALCULATION_QUEUE
} from "@external/queue/queue.module"
import {TenantEventQueuePayload} from "@external/queue/tenant-event-payload"
import {WORKER_OUTBOX_REPOSITORY_TOKEN, WorkerOutboxRepository, WorkError} from "@services/durable-work/interfaces"
import {TenantOutboxRelayService} from "@services/durable-work/tenant-outbox-relay.service"
import {QueueService} from "@services/queue/queue.service"
import {ServiceModule} from "@services/service.module"
import {
  cleanDatabase,
  cleanRedisByPrefix,
  createFixturePrismaClient,
  dropPreparedDatabase,
  prepareDatabase,
  prepareRedisPrefix
} from "@test/database"
import {createMockOrganization, MockConfigProvider} from "@test/mock-data"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import "@utils/matchers"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {v7 as uuidv7} from "uuid"

import {TenantOutboxRelayProcessor} from "../../src/processor/tenant-outbox-relay.processor"

jest.setTimeout(15000)

describe("TenantOutboxRelayProcessor real adapters", () => {
  let tenantDatabase: DatabaseClient
  let publication: TenantOutboxService
  let receipts: EventReceiptService
  let module: TestingModule
  let prisma: PrismaClient
  let processor: TenantOutboxRelayProcessor
  let outbox: WorkerOutboxRepository
  let queueService: QueueService
  let queue: Queue<TenantEventQueuePayload>
  let recalculationQueue: Queue<TenantEventQueuePayload>
  let statusQueue: Queue<TenantEventQueuePayload>
  let connection: string
  let redisPrefix: string

  beforeAll(async () => {
    connection = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()
    prisma = createFixturePrismaClient(connection)
    module = await Test.createTestingModule({imports: [ServiceModule.register({runtime: "worker"})]})
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromOriginalProvider({tenantConnectionUrl: connection, redisPrefix}))
      .compile()
    await module.init()
    // Competing tenant writes must use an independent connection and transaction context.
    const tenantUrl = new URL(connection)
    tenantUrl.username = "approvio_tenant"
    tenantDatabase = new DatabaseClient(
      MockConfigProvider.fromOriginalProvider({tenantConnectionUrl: tenantUrl.toString()}),
      "approvio_tenant_runtime"
    )
    await tenantDatabase.onModuleInit()
    publication = new TenantOutboxService(
      new TenantOutboxDbRepository(new TenantOutboxTenantClient(tenantDatabase)),
      new PrismaTransactionManager(tenantDatabase)
    )
    receipts = new EventReceiptService(
      new EventReceiptDbRepository(new EventReceiptTenantClient(tenantDatabase)),
      new PrismaTransactionManager(tenantDatabase)
    )
    processor = new TenantOutboxRelayProcessor(module.get(TenantOutboxRelayService), uuidv7())
    outbox = module.get(WORKER_OUTBOX_REPOSITORY_TOKEN)
    queueService = module.get(QueueService)
    queue = module.get(getQueueToken(WORKFLOW_ACTION_EMAIL_QUEUE))
    recalculationQueue = module.get(getQueueToken(WORKFLOW_STATUS_RECALCULATION_QUEUE))
    statusQueue = module.get(getQueueToken(WORKFLOW_STATUS_CHANGED_QUEUE))
  }, 30000)

  beforeEach(async () => {
    await cleanDatabase(prisma)
    await queue.empty()
    await recalculationQueue.empty()
    await statusQueue.empty()
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await tenantDatabase.onModuleDestroy()
    await module.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
    await cleanRedisByPrefix(redisPrefix)
  }, 30000)

  async function organization(status: "active" | "suspended" = "active") {
    const id = randomOrgId()
    await prisma.organization.create({
      data: createMockOrganization({id, slug: `relay-${id}`, displayName: "Relay org", status})
    })
    return id
  }

  async function events(organizationId: ReturnType<typeof toOrganizationId>, count: number) {
    const createdAt = new Date(Date.now() - 11 * 60000)
    const rows = Array.from({length: count}, () => {
      const eventId = uuidv7()
      const taskId = uuidv7()
      return {
        id: uuidv7(),
        organizationId,
        eventId,
        eventType: "task.ready",
        schemaVersion: 1,
        resourceId: taskId,
        resourceVersion: 1n,
        payload: {
          organizationId,
          eventId,
          type: "task.ready",
          schemaVersion: 1,
          taskKind: "email",
          taskId,
          taskOcc: "1"
        },
        availableAt: createdAt,
        createdAt,
        occ: 0n,
        attempts: 0n
      }
    })
    await prisma.tenantOutbox.createMany({data: rows})
    return rows
  }

  it("skips an event published after its claim candidate was read", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    wrapTaskEitherWithSideEffect(outbox, "listClaimCandidates", async () => {
      unwrapRight(await publication.markPublished({organizationId}, event.eventId)())
    })

    // When
    await processor.relay()

    // Expect: The competing publication survives; the stale candidate creates no queue job or lease.
    expect(await queue.getWaiting()).toHaveLength(0)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      publishedAt: expect.any(Date),
      attempts: 0n,
      leaseOwner: null,
      leaseUntil: null,
      occ: 1n
    })
  })

  it("skips an event consumed after its claim candidate was read", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    await prisma.tenantOutbox.update({where: {id: event.id}, data: {publishedAt: event.createdAt}})
    wrapTaskEitherWithSideEffect(outbox, "listClaimCandidates", async () => {
      unwrapRight(await receipts.record({organizationId}, "task_dispatch", event.eventId)())
    })

    // When
    await processor.relay()

    // Expect: The consumer receipt prevents recovery, including after a transaction retry.
    expect(await queue.getWaiting()).toHaveLength(0)
    expect(
      await prisma.tenantEventReceipt.count({
        where: {organizationId, eventId: event.eventId, consumer: "task_dispatch"}
      })
    ).toBe(1)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      publishedAt: event.createdAt,
      attempts: 0n,
      leaseOwner: null,
      leaseUntil: null,
      occ: 1n
    })
  })

  it("advances the outbox version only for a new consumer receipt", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    const context = {organizationId}

    // When
    const recorded = await receipts.record(context, "task_dispatch", event.eventId)()
    const replayed = await receipts.record(context, "task_dispatch", event.eventId)()

    // Expect
    expect(recorded).toBeRightOf("new")
    expect(replayed).toBeRightOf("duplicate")
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({occ: 1n})
  })

  it("acknowledges publication after a receipt changes OCC between the lease read and update", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    wrapTaskEitherWithSideEffect(outbox, "getAcknowledgementState", async () => {
      unwrapRight(await receipts.record({organizationId}, "task_dispatch", event.eventId)())
    })

    // When
    await processor.relay()

    // Expect: Acknowledgement retries the transaction without publishing another job.
    expect(await queue.getWaiting()).toHaveLength(1)
    expect(
      await prisma.tenantEventReceipt.count({
        where: {organizationId, eventId: event.eventId, consumer: "task_dispatch"}
      })
    ).toBe(1)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      publishedAt: expect.any(Date),
      attempts: 1n,
      leaseOwner: null,
      leaseUntil: null,
      occ: 3n
    })
  })

  it.each([
    {change: {leaseOwner: uuidv7()}, error: "lease_lost"},
    {change: {attempts: 2n}, error: "lease_lost"},
    {change: {publishedAt: new Date()}, error: "lease_lost"},
    {change: {leaseOwner: null, leaseUntil: null}, error: "lease_lost"},
    {change: {leaseOwner: null}, error: "lease_invalid_owner"},
    {change: {leaseUntil: null}, error: "lease_invalid_expires_at"},
    {change: {leaseUntil: new Date(0)}, error: "lease_lost"}
  ])("rejects acknowledgement with stored lease change $change as $error", async ({change, error}) => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    const owner = uuidv7()
    const expiresAt = new Date(Date.now() + 60_000)
    const lease = unwrapRight(LeaseFactory.validate({owner, fencing: 1n, expiresAt}))
    const before = await prisma.tenantOutbox.update({
      where: {id: event.id},
      data: {leaseOwner: owner, leaseUntil: expiresAt, attempts: 1n, ...change}
    })

    // When
    const result = await module.get(WorkerOutboxService).acknowledge({organizationId}, event.eventId, lease)()

    // Expect
    expect(result).toBeLeftOf(error)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toEqual(before)
  })

  it("leaves fresh events for post-commit publication", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    await prisma.tenantOutbox.update({where: {id: event.id}, data: {createdAt: new Date()}})

    // When
    await processor.relay()

    // Expect
    expect(await queue.getWaiting()).toHaveLength(0)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      attempts: 0n,
      leaseOwner: null,
      publishedAt: null
    })
  })

  it("relays a valid workflow.recalculate envelope and rejects an inconsistent resource version", async () => {
    // Given
    const organizationId = await organization()
    const resourceId = uuidv7()
    const base = {organizationId, schemaVersion: 1 as const, eventId: uuidv7()}
    const event: TenantEvent = {...base, type: "workflow.recalculate", workflowId: resourceId}
    const row = await prisma.tenantOutbox.create({
      data: {
        id: uuidv7(),
        organizationId,
        eventId: event.eventId,
        eventType: event.type,
        schemaVersion: 1,
        resourceId,
        resourceVersion: null,
        payload: mapToJsonValue(event),
        availableAt: new Date(),
        occ: 0n,
        attempts: 0n,
        createdAt: new Date(Date.now() - 11 * 60000)
      }
    })
    const enqueue = jest.spyOn(queueService, "enqueue").mockReturnValue(TE.right(undefined))

    // When
    await processor.relay()

    // Expect
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0]![0]).toEqual(event)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: row.id}})).toMatchObject({
      publishedAt: expect.any(Date)
    })

    // Given: an inconsistent stored version.
    await prisma.tenantOutbox.update({
      where: {id: row.id},
      data: {resourceVersion: 0n, publishedAt: null}
    })
    enqueue.mockClear()

    // When
    await processor.relay()

    // Expect: the malformed batch is not published or claimed.
    expect(enqueue).not.toHaveBeenCalled()
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: row.id}})).toMatchObject({
      attempts: 1n,
      publishedAt: null,
      leaseOwner: null,
      leaseUntil: null
    })
  })

  it("relays a valid usage.settlement envelope and rejects an inconsistent resource version", async () => {
    // Given
    const organizationId = await organization()
    const resourceId = uuidv7()
    const base = {organizationId, schemaVersion: 1 as const, eventId: uuidv7()}
    const event: TenantEvent = {...base, type: "usage.settlement", operationId: resourceId}
    const row = await prisma.tenantOutbox.create({
      data: {
        id: uuidv7(),
        organizationId,
        eventId: event.eventId,
        eventType: event.type,
        schemaVersion: 1,
        resourceId,
        resourceVersion: null,
        payload: mapToJsonValue(event),
        availableAt: new Date(),
        occ: 0n,
        attempts: 0n,
        createdAt: new Date(Date.now() - 11 * 60000)
      }
    })
    const enqueue = jest.spyOn(queueService, "enqueue").mockReturnValue(TE.right(undefined))

    // When
    await processor.relay()

    // Expect
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0]![0]).toEqual(event)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: row.id}})).toMatchObject({
      publishedAt: expect.any(Date)
    })

    // Given: an inconsistent stored version.
    await prisma.tenantOutbox.update({
      where: {id: row.id},
      data: {resourceVersion: 0n, publishedAt: null}
    })
    enqueue.mockClear()

    // When
    await processor.relay()

    // Expect: the malformed batch is not published or claimed.
    expect(enqueue).not.toHaveBeenCalled()
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: row.id}})).toMatchObject({
      attempts: 1n,
      publishedAt: null,
      leaseOwner: null,
      leaseUntil: null
    })
  })

  it("relays a valid task.ready envelope and rejects an inconsistent resource version", async () => {
    // Given
    const organizationId = await organization()
    const resourceId = uuidv7()
    const base = {organizationId, schemaVersion: 1 as const, eventId: uuidv7()}
    const event: TenantEvent = {...base, type: "task.ready", taskId: resourceId, taskKind: "email", taskOcc: 0n}
    const row = await prisma.tenantOutbox.create({
      data: {
        id: uuidv7(),
        organizationId,
        eventId: event.eventId,
        eventType: event.type,
        schemaVersion: 1,
        resourceId,
        resourceVersion: 0n,
        payload: mapToJsonValue(event),
        availableAt: new Date(),
        occ: 0n,
        attempts: 0n,
        createdAt: new Date(Date.now() - 11 * 60000)
      }
    })
    const enqueue = jest.spyOn(queueService, "enqueue").mockReturnValue(TE.right(undefined))

    // When
    await processor.relay()

    // Expect
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0]![0]).toEqual(event)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: row.id}})).toMatchObject({
      publishedAt: expect.any(Date)
    })

    // Given: an inconsistent stored version.
    await prisma.tenantOutbox.update({
      where: {id: row.id},
      data: {resourceVersion: null, publishedAt: null}
    })
    enqueue.mockClear()

    // When
    await processor.relay()

    // Expect: the malformed batch is not published or claimed.
    expect(enqueue).not.toHaveBeenCalled()
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: row.id}})).toMatchObject({
      attempts: 1n,
      publishedAt: null,
      leaseOwner: null,
      leaseUntil: null
    })
  })

  it("relays a valid workflow.status_changed envelope and rejects an inconsistent resource version", async () => {
    // Given
    const organizationId = await organization()
    const resourceId = uuidv7()
    const base = {organizationId, schemaVersion: 1 as const, eventId: uuidv7()}
    const event: TenantEvent = {
      ...base,
      type: "workflow.status_changed",
      workflowId: resourceId,
      workflowOcc: 0n,
      previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
      status: WorkflowStatus.APPROVED,
      workflowTemplateActions: [],
      occurredAt: new Date(),
      actor: {type: "system", displayName: "Workflow recalculation"}
    }
    const row = await prisma.tenantOutbox.create({
      data: {
        id: uuidv7(),
        organizationId,
        eventId: event.eventId,
        eventType: event.type,
        schemaVersion: 1,
        resourceId,
        resourceVersion: 0n,
        payload: mapToJsonValue(event),
        availableAt: new Date(),
        occ: 0n,
        attempts: 0n,
        createdAt: new Date(Date.now() - 11 * 60000)
      }
    })
    const enqueue = jest.spyOn(queueService, "enqueue").mockReturnValue(TE.right(undefined))

    // When
    await processor.relay()

    // Expect
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0]![0]).toEqual(event)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: row.id}})).toMatchObject({
      publishedAt: expect.any(Date)
    })

    // Given: an inconsistent stored version.
    await prisma.tenantOutbox.update({
      where: {id: row.id},
      data: {resourceVersion: null, publishedAt: null}
    })
    enqueue.mockClear()

    // When
    await processor.relay()

    // Expect: the malformed batch is not published or claimed.
    expect(enqueue).not.toHaveBeenCalled()
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: row.id}})).toMatchObject({
      attempts: 1n,
      publishedAt: null,
      leaseOwner: null,
      leaseUntil: null
    })
  })

  it.each([9_007_199_254_740_993n, 9_223_372_036_854_775_807n])(
    "preserves fencing %s in the queue job identity",
    async fencing => {
      // Given
      const id = await organization()
      const [event] = await events(id, 1)
      if (!event) throw new Error("Outbox fixture omitted its event")
      await prisma.tenantOutbox.update({where: {id: event.id}, data: {attempts: fencing - 1n}})

      // When
      await processor.relay()

      // Expect
      expect((await queue.getWaiting()).map(job => job.id)).toEqual([`${id}:${event.eventId}:${fencing}`])
      expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
        attempts: fencing,
        publishedAt: expect.any(Date),
        leaseOwner: null
      })
    }
  )

  it("claims an event once when two relay processors compete", async () => {
    // Given
    const id = await organization()
    await events(id, 1)
    const competing = new TenantOutboxRelayProcessor(module.get(TenantOutboxRelayService), uuidv7())

    // When
    await Promise.all([processor.relay(), competing.relay()])

    // Expect
    expect(await queue.getWaiting()).toHaveLength(1)
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {organizationId: id}})).toMatchObject({
      attempts: 1n,
      publishedAt: expect.any(Date),
      leaseOwner: null,
      leaseUntil: null
    })
  })

  it("rolls back a claimed batch when a stored event cannot be decoded", async () => {
    // Given
    const id = await organization()
    const rows = await events(id, 2)
    await prisma.tenantOutbox.update({where: {id: rows[1]!.id}, data: {payload: {}}})

    // When
    await processor.relay()

    // Expect
    expect(await queue.getWaiting()).toEqual([])
    expect(await prisma.tenantOutbox.findMany({where: {organizationId: id}})).toEqual(
      expect.arrayContaining(
        rows.map(row =>
          expect.objectContaining({id: row.id, attempts: 0n, publishedAt: null, leaseOwner: null, leaseUntil: null})
        )
      )
    )
  })

  it("recovers a published event when only a different consumer recorded a receipt", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    await prisma.tenantOutbox.update({where: {id: event.id}, data: {publishedAt: new Date(Date.now() - 11 * 60_000)}})
    await prisma.tenantEventReceipt.create({
      data: {organizationId, eventId: event.eventId, consumer: "recalculation", processedAt: new Date()}
    })

    // When
    await processor.relay()

    // Expect
    expect((await queue.getWaiting()).map(job => job.data.eventId)).toEqual([event.eventId])
  })

  it("publishes at most ten from a saturated org and reaches an active org beyond the first page", async () => {
    // Given
    const saturated = await organization()
    await events(saturated, 25)
    const paused = await organization("suspended")
    await events(paused, 1)
    for (let index = 0; index < 48; index++) await organization()
    const later = await organization()
    const [laterEvent] = await events(later, 1)
    // When
    await processor.relay()

    // Expect
    const jobs = await queue.getWaiting()
    expect(jobs).toHaveLength(11)
    expect(jobs.filter(job => job.data.organizationId === saturated)).toHaveLength(10)
    expect(jobs.filter(job => job.data.organizationId === later).map(job => job.data.eventId)).toEqual([
      laterEvent?.eventId
    ])
    expect(jobs.filter(job => job.data.organizationId === paused)).toHaveLength(0)
    expect(await prisma.tenantOutbox.count({where: {organizationId: saturated, publishedAt: null}})).toBe(15)
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {organizationId: paused}})).toMatchObject({
      publishedAt: null,
      leaseOwner: null,
      attempts: 0n
    })
  })

  it("defers an organization inserted beyond the scan bound until the next relay run", async () => {
    // Given
    const first = await organization()
    const [firstEvent] = await events(first, 1)
    for (let index = 0; index < 50; index++) await organization()
    let lateOrganization: typeof first | undefined
    wrapTaskEitherWithSideEffect(outbox, "listClaimCandidates", async () => {
      if (lateOrganization) return
      lateOrganization = await organization()
      await events(lateOrganization, 1)
    })

    // When
    await processor.relay()

    // Expect
    expect(lateOrganization).toBeDefined()
    expect((await queue.getWaiting()).map(job => job.data.eventId)).toEqual([firstEvent?.eventId])

    // When
    await processor.relay()

    // Expect
    expect((await queue.getWaiting()).map(job => job.data.organizationId)).toEqual(
      expect.arrayContaining([first, lateOrganization])
    )
    expect(await queue.getWaiting()).toHaveLength(2)
  })

  it("continues to another org after publication failure and recovers the unacknowledged batch", async () => {
    // Given
    const first = await organization()
    await events(first, 1)
    const second = await organization()
    await events(second, 1)
    const enqueue = jest.spyOn(queueService, "enqueue").mockReturnValueOnce(TE.left("unknown_error"))
    // When
    await processor.relay()
    enqueue.mockRestore()

    // Expect
    expect((await queue.getWaiting()).map(job => job.data.organizationId)).toEqual([second])
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {organizationId: first}})).toMatchObject({
      publishedAt: null,
      attempts: 1n
    })

    // Given: the failed publication's lease expires.
    await prisma.tenantOutbox.updateMany({where: {organizationId: first}, data: {leaseUntil: new Date(0)}})

    // When
    await processor.relay()

    // Expect
    expect((await queue.getWaiting()).map(job => job.data.organizationId).sort()).toEqual([first, second].sort())
    expect(await prisma.tenantOutbox.count({where: {publishedAt: null}})).toBe(0)
  })

  it("recovers an accepted Bull job after acknowledgement failure with a new delivery fence", async () => {
    // Given
    const id = await organization()
    const [event] = await events(id, 1)
    const owner = uuidv7()
    const acknowledge = jest.spyOn(outbox, "acknowledge").mockReturnValueOnce(TE.left("lease_lost"))
    // When
    await new TenantOutboxRelayProcessor(module.get(TenantOutboxRelayService), owner).relay()

    // Expect
    acknowledge.mockRestore()
    const before = await prisma.tenantOutbox.findFirstOrThrow()
    expect(before).toMatchObject({publishedAt: null, leaseOwner: owner, attempts: 1n})
    expect(await queue.getWaiting()).toHaveLength(1)

    // Given: the lease expires and the original owner attempts a stale acknowledgement.
    await prisma.tenantOutbox.updateMany({data: {leaseUntil: new Date(0)}})
    const originalAcknowledge = outbox.acknowledge.bind(outbox)
    let staleAcknowledgement: E.Either<WorkError, void> | undefined
    const recoveredAck = jest
      .spyOn(outbox, "acknowledge")
      .mockImplementationOnce((context, eventId, lease) => async () => {
        staleAcknowledgement = await module.get(WorkerOutboxService).acknowledge(
          context,
          eventId,
          unwrapRight(
            LeaseFactory.validate({
              owner,
              fencing: 1n,
              expiresAt: new Date()
            })
          )
        )()
        return originalAcknowledge(context, eventId, lease)()
      })
    // When
    await processor.relay()
    recoveredAck.mockRestore()

    // Expect
    expect(staleAcknowledgement).toBeLeftOf("lease_lost")
    expect((await queue.getWaiting()).map(job => job.id).sort()).toEqual(
      [`${id}:${event?.eventId}:1`, `${id}:${event?.eventId}:2`].sort()
    )
    expect(await prisma.tenantOutbox.findFirstOrThrow()).toMatchObject({
      attempts: 2n,
      leaseOwner: null,
      publishedAt: expect.any(Date)
    })
  })
  it("redelivers workflow.recalculate after ten minutes without a consumer receipt", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    const payload = {
      organizationId,
      eventId: event.eventId,
      type: "workflow.recalculate",
      schemaVersion: 1,
      workflowId: event.resourceId
    }
    await prisma.tenantOutbox.update({
      where: {id: event.id},
      data: {
        eventType: "workflow.recalculate",
        payload,
        resourceVersion: null,
        publishedAt: new Date(Date.now() - 11 * 60000)
      }
    })

    // When
    await processor.relay()

    // Expect
    expect((await recalculationQueue.getWaiting()).map(job => job.data.eventId)).toEqual([event.eventId])
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      attempts: 1n,
      publishedAt: expect.any(Date)
    })
  })

  it("does not redeliver workflow.recalculate after its consumer has recorded a receipt", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    const payload = {
      organizationId,
      eventId: event.eventId,
      type: "workflow.recalculate",
      schemaVersion: 1,
      workflowId: event.resourceId
    }
    await prisma.tenantOutbox.update({
      where: {id: event.id},
      data: {
        eventType: "workflow.recalculate",
        payload,
        resourceVersion: null,
        publishedAt: new Date(Date.now() - 11 * 60000)
      }
    })
    await prisma.tenantEventReceipt.create({
      data: {organizationId, eventId: event.eventId, consumer: "recalculation", processedAt: new Date()}
    })

    // When
    await processor.relay()

    // Expect
    expect(await queue.getWaiting()).toHaveLength(0)
    expect(await recalculationQueue.getWaiting()).toHaveLength(0)
    expect(await statusQueue.getWaiting()).toHaveLength(0)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      occ: 0n,
      attempts: 0n,
      leaseOwner: null
    })
  })

  it("redelivers workflow.status_changed after ten minutes without a consumer receipt", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    const payload = {
      organizationId,
      eventId: event.eventId,
      type: "workflow.status_changed",
      schemaVersion: 1,
      workflowId: event.resourceId,
      workflowOcc: "1",
      workflowTemplateActions: [],
      previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
      status: WorkflowStatus.APPROVED,
      occurredAt: new Date().toISOString(),
      actor: {type: "system", id: "workflow-recalculation", displayName: "Workflow recalculation"}
    }
    await prisma.tenantOutbox.update({
      where: {id: event.id},
      data: {
        eventType: "workflow.status_changed",
        payload,
        resourceVersion: 1n,
        publishedAt: new Date(Date.now() - 11 * 60000)
      }
    })

    // When
    await processor.relay()

    // Expect
    expect((await statusQueue.getWaiting()).map(job => job.data.eventId)).toEqual([event.eventId])
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      attempts: 1n,
      publishedAt: expect.any(Date)
    })
  })

  it("does not redeliver workflow.status_changed after its consumer has recorded a receipt", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    const payload = {
      organizationId,
      eventId: event.eventId,
      type: "workflow.status_changed",
      schemaVersion: 1,
      workflowId: event.resourceId,
      workflowOcc: "1",
      workflowTemplateActions: [],
      previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
      status: WorkflowStatus.APPROVED,
      occurredAt: new Date().toISOString(),
      actor: {type: "system", id: "workflow-recalculation", displayName: "Workflow recalculation"}
    }
    await prisma.tenantOutbox.update({
      where: {id: event.id},
      data: {
        eventType: "workflow.status_changed",
        payload,
        resourceVersion: 1n,
        publishedAt: new Date(Date.now() - 11 * 60000)
      }
    })
    await prisma.tenantEventReceipt.create({
      data: {organizationId, eventId: event.eventId, consumer: "task_generation", processedAt: new Date()}
    })

    // When
    await processor.relay()

    // Expect
    expect(await queue.getWaiting()).toHaveLength(0)
    expect(await recalculationQueue.getWaiting()).toHaveLength(0)
    expect(await statusQueue.getWaiting()).toHaveLength(0)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      occ: 0n,
      attempts: 0n,
      leaseOwner: null
    })
  })

  it("redelivers task.ready after ten minutes without a consumer receipt", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    const payload = event.payload
    await prisma.tenantOutbox.update({
      where: {id: event.id},
      data: {eventType: "task.ready", payload, resourceVersion: 1n, publishedAt: new Date(Date.now() - 11 * 60000)}
    })

    // When
    await processor.relay()

    // Expect
    expect((await queue.getWaiting()).map(job => job.data.eventId)).toEqual([event.eventId])
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      attempts: 1n,
      publishedAt: expect.any(Date)
    })
  })

  it("does not redeliver task.ready after its consumer has recorded a receipt", async () => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    const payload = event.payload
    await prisma.tenantOutbox.update({
      where: {id: event.id},
      data: {eventType: "task.ready", payload, resourceVersion: 1n, publishedAt: new Date(Date.now() - 11 * 60000)}
    })
    await prisma.tenantEventReceipt.create({
      data: {organizationId, eventId: event.eventId, consumer: "task_dispatch", processedAt: new Date()}
    })

    // When
    await processor.relay()

    // Expect
    expect(await queue.getWaiting()).toHaveLength(0)
    expect(await recalculationQueue.getWaiting()).toHaveLength(0)
    expect(await statusQueue.getWaiting()).toHaveLength(0)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      occ: 0n,
      attempts: 0n,
      leaseOwner: null
    })
  })
})
