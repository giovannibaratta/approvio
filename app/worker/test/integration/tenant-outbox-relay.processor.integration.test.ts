import {TenantOutboxService} from "@services/durable-work/tenant-outbox.service"
import {WorkflowStatus} from "@domain"
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
import {OUTBOX_REPOSITORY_TOKEN, OutboxRepository, WorkError} from "@services/durable-work/interfaces"
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
import {MockConfigProvider} from "@test/mock-data"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import "@utils/matchers"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {v7 as uuidv7} from "uuid"

import {TenantOutboxRelayProcessor} from "../../src/processor/tenant-outbox-relay.processor"

// Invoke the scheduled processor; downstream action consumers remain stopped so Bull jobs can be inspected.
jest.setTimeout(15000)

describe("TenantOutboxRelayProcessor real adapters", () => {
  let module: TestingModule
  let prisma: PrismaClient
  let processor: TenantOutboxRelayProcessor
  let outbox: OutboxRepository
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
    module = await Test.createTestingModule({imports: [ServiceModule.register({runtime: "api"})]})
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromOriginalProvider({tenantConnectionUrl: connection, redisPrefix}))
      .compile()
    await module.init()
    processor = new TenantOutboxRelayProcessor(module.get(TenantOutboxRelayService), uuidv7())
    outbox = module.get(OUTBOX_REPOSITORY_TOKEN)
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
    await module.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
    await cleanRedisByPrefix(redisPrefix)
  }, 30000)

  async function organization(status: "active" | "suspended" = "active") {
    const id = randomOrgId()
    const now = new Date()
    await prisma.organization.create({
      data: {
        id,
        slug: `relay-${id}`,
        displayName: "Relay org",
        status,
        planTier: "FREE",
        occ: 0n,
        createdAt: now,
        updatedAt: now
      }
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
        attempts: 0
      }
    })
    await prisma.tenantOutbox.createMany({data: rows})
    return rows
  }

  it("leaves fresh events for post-commit publication", async () => {
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    await prisma.tenantOutbox.update({where: {id: event.id}, data: {createdAt: new Date()}})

    await processor.relay()

    expect(await queue.getWaiting()).toHaveLength(0)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      attempts: 0,
      leaseOwner: null,
      publishedAt: null
    })
  })

  it("recovers a published event when only a different consumer recorded a receipt", async () => {
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    await prisma.tenantOutbox.update({where: {id: event.id}, data: {publishedAt: new Date(Date.now() - 11 * 60_000)}})
    await prisma.tenantEventReceipt.create({
      data: {organizationId, eventId: event.eventId, consumer: "recalculation", processedAt: new Date()}
    })

    await processor.relay()

    expect((await queue.getWaiting()).map(job => job.data.eventId)).toEqual([event.eventId])
  })

  it("rejects an empty worker owner through the processor boundary", async () => {
    await expect(new TenantOutboxRelayProcessor(module.get(TenantOutboxRelayService), " ").relay()).rejects.toThrow(
      "lease_invalid_owner"
    )
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
      attempts: 0
    })
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
      attempts: 1
    })
    await prisma.tenantOutbox.updateMany({where: {organizationId: first}, data: {leaseUntil: new Date(0)}})
    await processor.relay()
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
    expect(before).toMatchObject({publishedAt: null, leaseOwner: owner, attempts: 1})
    expect(await queue.getWaiting()).toHaveLength(1)
    await prisma.tenantOutbox.updateMany({data: {leaseUntil: new Date(0)}})
    const originalAcknowledge = outbox.acknowledge.bind(outbox)
    let staleAcknowledgement: E.Either<WorkError, void> | undefined
    const recoveredAck = jest
      .spyOn(outbox, "acknowledge")
      .mockImplementationOnce((context, eventId, lease) => async () => {
        staleAcknowledgement = await module.get(TenantOutboxService).acknowledge(
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
    await processor.relay()
    recoveredAck.mockRestore()
    expect(staleAcknowledgement).toBeLeftOf("lease_lost")
    expect((await queue.getWaiting()).map(job => job.id).sort()).toEqual(
      [`${id}:${event?.eventId}:1`, `${id}:${event?.eventId}:2`].sort()
    )
    expect(await prisma.tenantOutbox.findFirstOrThrow()).toMatchObject({
      attempts: 2,
      leaseOwner: null,
      publishedAt: expect.any(Date)
    })
  })
  it.each([
    {eventType: "workflow.recalculate", consumer: "recalculation"},
    {eventType: "workflow.status_changed", consumer: "task_generation"},
    {eventType: "task.ready", consumer: "task_dispatch"}
  ] as const)("redelivers $eventType after ten minutes without a consumer receipt", async ({eventType}) => {
    // Given
    const organizationId = await organization()
    const [event] = await events(organizationId, 1)
    if (!event) throw new Error("Relay fixture omitted its event")
    const payload =
      eventType === "task.ready"
        ? event.payload
        : {
            organizationId,
            eventId: event.eventId,
            type: eventType,
            schemaVersion: 1,
            workflowId: event.resourceId,
            ...(eventType === "workflow.status_changed"
              ? {
                  workflowOcc: "1",
                  previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
                  status: WorkflowStatus.APPROVED,
                  occurredAt: new Date().toISOString(),
                  actor: {type: "system", id: "workflow-recalculation", displayName: "Workflow recalculation"}
                }
              : {})
          }
    await prisma.tenantOutbox.update({
      where: {id: event.id},
      data: {
        eventType,
        payload,
        resourceVersion: eventType === "workflow.recalculate" ? 0n : 1n,
        publishedAt: new Date(Date.now() - 11 * 60000)
      }
    })

    // When
    await processor.relay()

    // Expect
    const jobs = await (
      eventType === "task.ready" ? queue : eventType === "workflow.status_changed" ? statusQueue : recalculationQueue
    ).getWaiting()
    expect(jobs.map(job => job.data.eventId)).toEqual([event.eventId])
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
      attempts: 1,
      publishedAt: expect.any(Date)
    })
  })

  it.each([
    {eventType: "workflow.recalculate", consumer: "recalculation"},
    {eventType: "workflow.status_changed", consumer: "task_generation"},
    {eventType: "task.ready", consumer: "task_dispatch"}
  ] as const)(
    "does not redeliver $eventType after its consumer has recorded a receipt",
    async ({eventType, consumer}) => {
      // Given
      const organizationId = await organization()
      const [event] = await events(organizationId, 1)
      if (!event) throw new Error("Relay fixture omitted its event")
      const payload =
        eventType === "task.ready"
          ? event.payload
          : {
              organizationId,
              eventId: event.eventId,
              type: eventType,
              schemaVersion: 1,
              workflowId: event.resourceId,
              ...(eventType === "workflow.status_changed"
                ? {
                    workflowOcc: "1",
                    previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
                    status: WorkflowStatus.APPROVED,
                    occurredAt: new Date().toISOString(),
                    actor: {type: "system", id: "workflow-recalculation", displayName: "Workflow recalculation"}
                  }
                : {})
            }
      await prisma.tenantOutbox.update({
        where: {id: event.id},
        data: {
          eventType,
          payload,
          resourceVersion: eventType === "workflow.recalculate" ? 0n : 1n,
          publishedAt: new Date(Date.now() - 11 * 60000)
        }
      })
      await prisma.tenantEventReceipt.create({
        data: {organizationId, eventId: event.eventId, consumer, processedAt: new Date()}
      })

      // When
      await processor.relay()

      // Expect
      expect(await queue.getWaiting()).toHaveLength(0)
      expect(await recalculationQueue.getWaiting()).toHaveLength(0)
      expect(await statusQueue.getWaiting()).toHaveLength(0)
      expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({
        attempts: 0,
        leaseOwner: null
      })
    }
  )
})
