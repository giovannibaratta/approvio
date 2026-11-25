import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {WorkflowRecalculationProcessor} from "../../src/processor/workflow-recalculation.processor"
import {TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider, createMockWorkflowInDb, createMockWorkflowTemplateInDb} from "@test/mock-data"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {PrismaClient} from "@prisma/client"
import {Job} from "bull"
import {TenantEvent, TenantEventFactory, WorkflowActionType, WorkflowRecalculateEvent, WorkflowStatus} from "@domain"
import {setupWorkerTestModule} from "./test-helpers"
import {appendTenantEvent} from "./test-helpers"
import {TENANT_OUTBOX_REPOSITORY_TOKEN, TenantOutboxRepository} from "@services/durable-work/interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import {unwrapRight} from "@utils/either"
import {WORKFLOW_REPOSITORY_TOKEN, WorkflowRepository} from "@services/workflow/interfaces"
import {wrapTaskEitherWithSideEffect} from "@test/injectors"

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
  let outbox: TenantOutboxRepository
  let transactionManager: TenantTransactionManager

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
    outbox = module.get<TenantOutboxRepository>(TENANT_OUTBOX_REPOSITORY_TOKEN)
    transactionManager = module.get<TenantTransactionManager>(TRANSACTION_MANAGER_TOKEN)
    prisma = createFixturePrismaClient(isolatedDb)

    // Initialize the module to ensure all providers are ready
    await module.init()
  }, 30000)

  afterAll(async () => {
    await prisma.$disconnect()
    await module.close()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await cleanDatabase(prisma)
    await cleanRedisByPrefix(redisPrefix)
  })

  it("should be defined", () => {
    expect(processor).toBeDefined()
  })

  describe("process", () => {
    it("persists the template actions snapshot with the status-change event", async () => {
      // Given
      const actions = [{type: WorkflowActionType.EMAIL, recipients: ["snapshot@example.com"]}] as const
      const template = await createMockWorkflowTemplateInDb(prisma, {actions})
      const workflow = await createMockWorkflowInDb(prisma, {
        name: "expired-snapshot",
        organizationId: template.organizationId,
        workflowTemplateId: template.id,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        expiresAt: "expired"
      })
      const event = recalculationEvent(workflow.organizationId, workflow.id)
      unwrapRight(await appendTenantEvent(transactionManager, outbox, event)())

      // When
      await processor.process({data: event, attemptsMade: 0, opts: {attempts: 3}, id: "snapshot-recalculation"})

      // Expect
      const persisted = await prisma.tenantOutbox.findFirstOrThrow({
        where: {eventType: "workflow.status_changed", resourceId: workflow.id}
      })
      expect(unwrapRight(TenantEventFactory.validate(persisted.payload))).toMatchObject({
        status: WorkflowStatus.EXPIRED,
        workflowOcc: workflow.occ,
        workflowTemplateActions: actions
      })
      expect(await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).toMatchObject({
        status: WorkflowStatus.EXPIRED,
        occ: workflow.occ + 1n
      })
    })

    it("rejects a recalculation request with a different workflow without changing workflows or recording a receipt", async () => {
      // Given
      const source = await createMockWorkflowInDb(prisma, {
        name: "event-source",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      const target = await createMockWorkflowInDb(prisma, {
        name: "event-target",
        organizationId: source.organizationId,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      await prisma.workflow.updateMany({
        where: {id: {in: [source.id, target.id]}},
        data: {recalculationRequired: true}
      })
      const committed: TenantEvent = recalculationEvent(source.organizationId, source.id)
      unwrapRight(await appendTenantEvent(transactionManager, outbox, committed)())
      const received = recalculationEvent(target.organizationId, target.id)
      const before = await prisma.workflow.findMany({orderBy: {id: "asc"}})
      const outboxBefore = await prisma.tenantOutbox.findMany()

      // When
      const request = processor.process({
        data: received,
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "mismatched-event"
      })

      // Expect
      await expect(request).rejects.toThrow("Workflow recalculation failed: event_mismatch")
      expect(await prisma.workflow.findMany({orderBy: {id: "asc"}})).toEqual(before)
      expect(await prisma.tenantEventReceipt.count()).toBe(0)
      expect(await prisma.tenantOutbox.findMany()).toEqual(outboxBefore)
    })

    it("rejects a recalculation request with a different organization without changing workflows or recording a receipt", async () => {
      // Given
      const source = await createMockWorkflowInDb(prisma, {
        name: "event-source",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      const target = await createMockWorkflowInDb(prisma, {
        name: "event-target",
        organizationId: randomOrgId(),
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      await prisma.workflow.updateMany({
        where: {id: {in: [source.id, target.id]}},
        data: {recalculationRequired: true}
      })
      const committed: TenantEvent = recalculationEvent(source.organizationId, source.id)
      unwrapRight(await appendTenantEvent(transactionManager, outbox, committed)())
      const received = recalculationEvent(target.organizationId, target.id)
      const before = await prisma.workflow.findMany({orderBy: {id: "asc"}})
      const outboxBefore = await prisma.tenantOutbox.findMany()

      // When
      const request = processor.process({
        data: received,
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "mismatched-event"
      })

      // Expect
      await expect(request).rejects.toThrow("Workflow recalculation failed: event_not_found")
      expect(await prisma.workflow.findMany({orderBy: {id: "asc"}})).toEqual(before)
      expect(await prisma.tenantEventReceipt.count()).toBe(0)
      expect(await prisma.tenantOutbox.findMany()).toEqual(outboxBefore)
    })

    it("rejects a recalculation request with a different event type without changing workflows or recording a receipt", async () => {
      // Given
      const source = await createMockWorkflowInDb(prisma, {
        name: "event-source",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      const target = await createMockWorkflowInDb(prisma, {
        name: "event-target",
        organizationId: source.organizationId,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      await prisma.workflow.updateMany({
        where: {id: {in: [source.id, target.id]}},
        data: {recalculationRequired: true}
      })
      const committed: TenantEvent = {
        organizationId: toOrganizationId(source.organizationId),
        schemaVersion: 1,
        eventId: recalculationEvent(source.organizationId, source.id).eventId,
        type: "usage.settlement",
        operationId: source.id
      }
      unwrapRight(await appendTenantEvent(transactionManager, outbox, committed)())
      const received = recalculationEvent(target.organizationId, target.id)
      const before = await prisma.workflow.findMany({orderBy: {id: "asc"}})
      const outboxBefore = await prisma.tenantOutbox.findMany()

      // When
      const request = processor.process({
        data: received,
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "mismatched-event"
      })

      // Expect
      await expect(request).rejects.toThrow("Workflow recalculation failed: event_mismatch")
      expect(await prisma.workflow.findMany({orderBy: {id: "asc"}})).toEqual(before)
      expect(await prisma.tenantEventReceipt.count()).toBe(0)
      expect(await prisma.tenantOutbox.findMany()).toEqual(outboxBefore)
    })

    it("rejects a recalculation request with a missing event without changing workflows or recording a receipt", async () => {
      // Given
      const source = await createMockWorkflowInDb(prisma, {
        name: "event-source",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      const target = await createMockWorkflowInDb(prisma, {
        name: "event-target",
        organizationId: source.organizationId,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      await prisma.workflow.updateMany({
        where: {id: {in: [source.id, target.id]}},
        data: {recalculationRequired: true}
      })
      const received = recalculationEvent(target.organizationId, target.id)
      const before = await prisma.workflow.findMany({orderBy: {id: "asc"}})
      const outboxBefore = await prisma.tenantOutbox.findMany()

      // When
      const request = processor.process({
        data: received,
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "mismatched-event"
      })

      // Expect
      await expect(request).rejects.toThrow("Workflow recalculation failed: event_not_found")
      expect(await prisma.workflow.findMany({orderBy: {id: "asc"}})).toEqual(before)
      expect(await prisma.tenantEventReceipt.count()).toBe(0)
      expect(await prisma.tenantOutbox.findMany()).toEqual(outboxBefore)
    })

    it("rejects a recalculation request with an invalid envelope without changing workflows or recording a receipt", async () => {
      // Given
      const source = await createMockWorkflowInDb(prisma, {
        name: "event-source",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      const target = await createMockWorkflowInDb(prisma, {
        name: "event-target",
        organizationId: source.organizationId,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      await prisma.workflow.updateMany({
        where: {id: {in: [source.id, target.id]}},
        data: {recalculationRequired: true}
      })
      const committed: TenantEvent = recalculationEvent(source.organizationId, source.id)
      unwrapRight(await appendTenantEvent(transactionManager, outbox, committed)())
      await prisma.tenantOutbox.updateMany({where: {eventId: committed.eventId}, data: {payload: {}}})
      const received = recalculationEvent(target.organizationId, target.id)
      const before = await prisma.workflow.findMany({orderBy: {id: "asc"}})
      const outboxBefore = await prisma.tenantOutbox.findMany()

      // When
      const request = processor.process({
        data: received,
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "mismatched-event"
      })

      // Expect
      await expect(request).rejects.toThrow("Workflow recalculation failed: tenant_event_organization_id_invalid")
      expect(await prisma.workflow.findMany({orderBy: {id: "asc"}})).toEqual(before)
      expect(await prisma.tenantEventReceipt.count()).toBe(0)
      expect(await prisma.tenantOutbox.findMany()).toEqual(outboxBefore)
    })

    it("rejects a stale workflow update and rolls back its receipt through the processor", async () => {
      // Given
      const workflow = await createMockWorkflowInDb(prisma, {
        name: "concurrent-workflow-update",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        expiresAt: "expired"
      })
      const before = await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})
      const event = recalculationEvent(workflow.organizationId, workflow.id)
      unwrapRight(await appendTenantEvent(transactionManager, outbox, event)())
      const repository = module.get<WorkflowRepository>(WORKFLOW_REPOSITORY_TOKEN)
      wrapTaskEitherWithSideEffect(repository, "getWorkflowById", async () => {
        await prisma.workflow.update({where: {id: workflow.id}, data: {occ: {increment: 1}}})
      })

      // When / Expect
      await expect(
        processor.process({data: event, attemptsMade: 0, opts: {attempts: 3}, id: "stale-workflow"})
      ).rejects.toThrow("concurrency_error")
      expect(await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).toEqual({
        ...before,
        occ: before.occ + 1n
      })
      expect(await prisma.tenantEventReceipt.count({where: {eventId: event.eventId}})).toBe(0)
      expect(await prisma.tenantOutbox.count({where: {eventType: "workflow.status_changed"}})).toBe(0)
    })

    it("consumes concurrent deliveries of one recalculation event only once", async () => {
      // Given
      const workflow = await createMockWorkflowInDb(prisma, {
        name: "concurrent-recalculation",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })
      await prisma.workflow.update({where: {id: workflow.id}, data: {recalculationRequired: true}})
      const event = recalculationEvent(workflow.organizationId, workflow.id)
      unwrapRight(await appendTenantEvent(transactionManager, outbox, event)())
      const job = {data: event, attemptsMade: 0, opts: {attempts: 3}, id: "concurrent-event"}

      // When
      await Promise.all([processor.process(job), processor.process(job)])

      // Expect
      expect(await prisma.tenantEventReceipt.count({where: {eventId: event.eventId, consumer: "recalculation"}})).toBe(
        1
      )
      expect(await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).toMatchObject({
        recalculationRequired: false
      })
      expect(await prisma.tenantOutbox.count({where: {organizationId: event.organizationId}})).toBe(1)
    })

    it("rolls back the receipt when recalculation rejects a malformed persisted workflow", async () => {
      // Given
      const workflow = await createMockWorkflowInDb(prisma, {name: "receipt-rollback"})
      const event = recalculationEvent(workflow.organizationId, workflow.id)
      unwrapRight(await appendTenantEvent(transactionManager, outbox, event)())
      await prisma.workflow.update({where: {id: workflow.id}, data: {name: "", recalculationRequired: true}})
      const before = await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})

      // When / Expect
      await expect(
        processor.process({data: event, attemptsMade: 0, opts: {attempts: 3}, id: "failed-recalculation"})
      ).rejects.toThrow("workflow_name_empty")
      expect(await prisma.tenantEventReceipt.count({where: {eventId: event.eventId}})).toBe(0)
      expect(await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).toEqual(before)
    })

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
      const job = {data: event, attemptsMade: 0, opts: {attempts: 3}, id: "job-1"}

      // When
      await processor.process(job)

      // Expect
      const updatedWorkflow = await prisma.workflow.findUniqueOrThrow({
        where: {id: workflow.id}
      })

      expect(updatedWorkflow.recalculationRequired).toBe(false)
      // Status might remain the same if no votes, but the flag should be cleared
      expect(updatedWorkflow.status).toBe(WorkflowStatus.EVALUATION_IN_PROGRESS)
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
