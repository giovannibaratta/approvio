import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {WorkflowRecalculationProcessor} from "../../src/processor/workflow-recalculation.processor"
import {TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider, createMockWorkflowInDb} from "@test/mock-data"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {PrismaClient} from "@prisma/client"
import {Job} from "bull"
import {TenantEvent, WorkflowRecalculateEvent, WorkflowStatus} from "@domain"
import {setupWorkerTestModule} from "./test-helpers"
import {appendTenantEvent} from "./test-helpers"
import {OUTBOX_REPOSITORY_TOKEN, OutboxRepository} from "@services/durable-work/interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import {unwrapRight} from "@utils/either"
import {getQueueToken} from "@nestjs/bull"
import {Queue} from "bull"
import {WORKFLOW_STATUS_RECALCULATION_QUEUE} from "@external/queue/queue.module"
import {QUEUE_PROVIDER_TOKEN, QueueProvider} from "@services/queue/interface"

function recalculationEvent(organizationId: string, workflowId: string): WorkflowRecalculateEvent {
  return {
    organizationId: toOrganizationId(organizationId),
    schemaVersion: 1,
    eventId: "0198ed6b-0c41-7000-8000-000000000011",
    workflowId,
    type: "workflow.recalculate"
  }
}

describe("WorkflowRecalculationProcessor Integration", () => {
  let processor: WorkflowRecalculationProcessor
  let prisma: PrismaClient
  let redisPrefix: string
  let module: TestingModule
  let outbox: OutboxRepository
  let transactionManager: TenantTransactionManager
  let queue: Queue
  let queueProvider: QueueProvider

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    try {
      const moduleBuilder = setupWorkerTestModule([WorkflowRecalculationProcessor])
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb, redisPrefix))

      module = await moduleBuilder.compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    processor = module.get<WorkflowRecalculationProcessor>(WorkflowRecalculationProcessor)
    outbox = module.get<OutboxRepository>(OUTBOX_REPOSITORY_TOKEN)
    transactionManager = module.get<TenantTransactionManager>(TRANSACTION_MANAGER_TOKEN)
    queue = module.get<Queue>(getQueueToken(WORKFLOW_STATUS_RECALCULATION_QUEUE))
    queueProvider = module.get<QueueProvider>(QUEUE_PROVIDER_TOKEN)
    prisma = createFixturePrismaClient(isolatedDb)

    // Initialize the module to ensure all providers are ready
    await module.init()
  }, 30000)

  afterAll(async () => {
    await prisma.$disconnect()
    await module.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
    await cleanRedisByPrefix(redisPrefix)
  })

  it("should be defined", () => {
    expect(processor).toBeDefined()
  })

  describe("process", () => {
    it.each([
      {mismatch: "different workflow", error: "event_mismatch"},
      {mismatch: "different organization", error: "event_not_found"},
      {mismatch: "different event type", error: "event_mismatch"},
      {mismatch: "missing event", error: "event_not_found"},
      {mismatch: "invalid envelope", error: "tenant_event_organization_id_invalid"}
    ])(
      "rejects a recalculation request with a $mismatch before changing workflows or recording a receipt",
      async ({mismatch, error}) => {
        // Given: the committed event belongs to the source workflow; the received request targets another workflow.
        const source = await createMockWorkflowInDb(prisma, {
          name: "event-source",
          status: WorkflowStatus.EVALUATION_IN_PROGRESS
        })
        const target = await createMockWorkflowInDb(prisma, {
          name: "event-target",
          organizationId: mismatch === "different organization" ? randomOrgId() : source.organizationId,
          status: WorkflowStatus.EVALUATION_IN_PROGRESS
        })
        await prisma.workflow.updateMany({
          where: {id: {in: [source.id, target.id]}},
          data: {recalculationRequired: true}
        })
        const committed: TenantEvent =
          mismatch === "different event type"
            ? {
                organizationId: toOrganizationId(source.organizationId),
                schemaVersion: 1,
                eventId: recalculationEvent(source.organizationId, source.id).eventId,
                type: "organization.resumed"
              }
            : recalculationEvent(source.organizationId, source.id)
        if (mismatch !== "missing event") unwrapRight(await appendTenantEvent(transactionManager, outbox, committed)())
        if (mismatch === "invalid envelope")
          await prisma.tenantOutbox.updateMany({where: {eventId: committed.eventId}, data: {payload: {}}})
        const received = recalculationEvent(target.organizationId, target.id)
        const before = await prisma.workflow.findMany({orderBy: {id: "asc"}})
        const outboxBefore = await prisma.tenantOutbox.findMany()

        // When: the queue payload reuses the event ID with a different target, type or tenant, or no committed event.
        const request = processor.process({
          data: received,
          attemptsMade: 0,
          opts: {attempts: 3},
          id: "mismatched-event"
        })

        // Expect: reject the request without consuming the legitimate event or changing either workflow.
        await expect(request).rejects.toThrow(`Workflow recalculation failed: ${error}`)
        expect(await prisma.workflow.findMany({orderBy: {id: "asc"}})).toEqual(before)
        expect(await prisma.tenantEventReceipt.count()).toBe(0)
        expect(await prisma.tenantOutbox.findMany()).toEqual(outboxBefore)
      }
    )

    it("skips a matching event after its recalculation has committed", async () => {
      // Given: a committed recalculation request for an active workflow with no votes.
      const workflow = await createMockWorkflowInDb(prisma, {
        name: "replayed-recalculation",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      await prisma.workflow.update({where: {id: workflow.id}, data: {recalculationRequired: true}})
      const event = recalculationEvent(workflow.organizationId, workflow.id)
      unwrapRight(await appendTenantEvent(transactionManager, outbox, event)())
      const job = {data: event, attemptsMade: 0, opts: {attempts: 3}, id: "replayed-event"}
      await processor.process(job)
      const afterFirst = await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})

      // When: the same event is delivered again.
      await processor.process(job)

      // Expect: the first request clears the flag; replay does not change the version or produce another event.
      expect(afterFirst.recalculationRequired).toBe(false)
      expect(await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).toEqual(afterFirst)
      expect(await prisma.tenantEventReceipt.count({where: {consumer: "recalculation"}})).toBe(1)
      expect(await prisma.tenantOutbox.count()).toBe(1)
    })

    it("should successfully recalculate workflow status and update recalculationRequired to false", async () => {
      // Given: A workflow that requires recalculation
      const workflow = await createMockWorkflowInDb(prisma, {
        name: "Workflow-To-Recalculate",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })

      // Manually set recalculationRequired to true (createMockWorkflowInDb sets it to false by default)
      await prisma.workflow.update({
        where: {id: workflow.id},
        data: {recalculationRequired: true}
      })

      const event = recalculationEvent(workflow.organizationId, workflow.id)
      unwrapRight(await appendTenantEvent(transactionManager, outbox, event)())
      unwrapRight(await queueProvider.enqueue(event)())

      // When
      const job = await queue.getJob(`${event.organizationId}:${event.eventId}:0`)
      if (!job) throw new Error("Queue provider did not create the workflow-recalculation job")
      expect(job.name).toBe("recalculate-workflow")
      await job.finished()

      // Then
      const updatedWorkflow = await prisma.workflow.findUnique({
        where: {id: workflow.id}
      })

      expect(updatedWorkflow).toBeDefined()
      expect(updatedWorkflow?.recalculationRequired).toBe(false)
      // Status might remain the same if no votes, but the flag should be cleared
      expect(updatedWorkflow?.status).toBe(WorkflowStatus.EVALUATION_IN_PROGRESS)
    })

    it("should throw an error if workflow does not exist", async () => {
      // Given: A job with a non-existent workflow ID (but valid UUID format)
      const organizationId = randomOrgId()
      await createMockWorkflowInDb(prisma, {name: "workflow-seed", organizationId})
      const job = {
        data: recalculationEvent(organizationId, "00000000-0000-7000-8000-000000000000"),
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "job-2"
      } as Job<TenantEvent>

      unwrapRight(await appendTenantEvent(transactionManager, outbox, job.data)())

      // When/Then: The processor should throw an error
      await expect(processor.process(job)).rejects.toThrow("Workflow recalculation failed")
    })

    it("should throw an error if workflow ID is not a valid UUID", async () => {
      // Given: A job with an invalid UUID format
      const organizationId = randomOrgId()
      const job = {
        data: recalculationEvent(organizationId, "non-existent-id"),
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "job-3"
      } as Job<TenantEvent>

      // When/Then: The processor should throw an error about invalid format
      await expect(processor.process(job)).rejects.toThrow("Invalid workflow ID format")
    })
  })
})
