import {serializeTenantEvent} from "@external/queue/tenant-event-payload"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {WorkflowActionWebhookProcessor} from "../../src/processor/workflow-action-webhook.processor"
import {TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {createMockSpaceInDb, createMockWorkflowTemplateInDb, MockConfigProvider} from "@test/mock-data"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {PrismaClient} from "@prisma/client"
import {InertQueueProvider, persistTaskFixture, setupWorkerTestModule} from "./test-helpers"
import {
  TASK_ID_NAMESPACE,
  WorkflowActionWebhookTaskFactory,
  WebhookActionHttpMethod,
  WorkflowStatus,
  TaskReadyEvent
} from "@domain"
import {TaskService, WebhookService} from "@services"
import {QUEUE_PROVIDER_TOKEN} from "@services/queue/interface"

import {createWiremockUrl, getWiremockRequestsFor, setupWiremockStub} from "@test/wiremock"
import {v5 as uuidv5, v7 as uuidv7} from "uuid"

import {unwrapRight} from "@utils/either"

async function createWorkflowWithWebhookTask(
  prisma: PrismaClient,
  module: TestingModule,
  webhookUrl: string,
  method: WebhookActionHttpMethod = WebhookActionHttpMethod.POST,
  headers: Record<string, string> = {"Content-Type": "application/json"},
  payload: unknown = {message: "test payload"}
) {
  // Create a space and template first
  const space = await createMockSpaceInDb(prisma)
  const template = await createMockWorkflowTemplateInDb(prisma, {
    organizationId: space.organizationId,
    spaceId: space.id
  })

  // Create a workflow
  const workflow = await prisma.workflow.create({
    data: {
      id: uuidv7(),
      organizationId: template.organizationId,
      name: "Test-Webhook-Workflow",
      status: WorkflowStatus.EVALUATION_IN_PROGRESS,
      workflowTemplateId: template.id,
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      updatedAt: new Date(),
      occ: 0n,
      recalculationRequired: false
    }
  })

  // Create a webhook task
  const webhookTask = unwrapRight(
    WorkflowActionWebhookTaskFactory.newWorkflowActionWebhookTask({
      id: uuidv5(`webhook-task-${workflow.id}`, TASK_ID_NAMESPACE),
      organizationId: toOrganizationId(template.organizationId),
      workflowId: workflow.id,
      url: webhookUrl,
      method,
      headers,
      payload
    })
  )

  const event = await persistTaskFixture(module, {
    kind: "webhook",
    request: {
      task: webhookTask,
      metadata: {
        eventId: uuidv7(),
        actionIndex: 0,
        availableAt: webhookTask.createdAt
      }
    }
  })

  return {workflowId: workflow.id, organizationId: template.organizationId, taskId: webhookTask.id, event}
}

describe("Workflow Action Webhook Processor Integration", () => {
  let processor: WorkflowActionWebhookProcessor
  let prisma: PrismaClient
  let redisPrefix: string
  let module: TestingModule
  let uniqueWebhookPath: string
  let wiremockUrl: string
  let taskService: TaskService

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    try {
      const moduleBuilder = setupWorkerTestModule([WorkflowActionWebhookProcessor])
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb, redisPrefix))
        .overrideProvider(QUEUE_PROVIDER_TOKEN)
        .useClass(InertQueueProvider)

      module = await moduleBuilder.compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    processor = module.get<WorkflowActionWebhookProcessor>(WorkflowActionWebhookProcessor)
    prisma = createFixturePrismaClient(isolatedDb)
    taskService = module.get(TaskService)

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

  beforeEach(() => {
    uniqueWebhookPath = `/webhook-${uuidv7()}`
    wiremockUrl = createWiremockUrl(uniqueWebhookPath)
  })

  it("should be defined", () => {
    expect(processor).toBeDefined()
  })

  describe("process", () => {
    it("rejects an organization A envelope referencing organization B's task before egress", async () => {
      // Given: B owns a ready webhook task; A is a different persisted organization.
      const {taskId, organizationId} = await createWorkflowWithWebhookTask(prisma, module, wiremockUrl)
      const organizationA = randomOrgId()
      await createMockSpaceInDb(prisma, {organizationId: organizationA})
      await setupWiremockStub("POST", uniqueWebhookPath, 200, {success: true})
      const forged: TaskReadyEvent = {
        schemaVersion: 1,
        eventId: uuidv7(),
        taskOcc: 0n,
        organizationId: organizationA,
        taskId,
        taskKind: "webhook",
        type: "task.ready"
      }

      // When: a forged queue envelope keeps A's context but substitutes B's task ID.
      await expect(processor.handleWebhookAction({data: serializeTenantEvent(forged)})).rejects.toThrow(
        "event_not_found"
      )

      // Expect: stored tenant ownership prevents payload loading, attempt creation and external delivery.
      expect(await getWiremockRequestsFor("POST", uniqueWebhookPath)).toHaveLength(0)
      expect(await prisma.dispatchAttempt.count({where: {taskId}})).toBe(0)
      expect(
        await prisma.durableWork.findUniqueOrThrow({
          where: {
            organizationId_id: {organizationId, id: taskId}
          }
        })
      ).toMatchObject({state: DispatchWorkState.READY, attempts: 0, fencing: 0n})
    })

    it("does not send a completed task again when its event is replayed", async () => {
      // Given: a persisted webhook task and its committed outbox envelope.
      const {taskId, organizationId, event} = await createWorkflowWithWebhookTask(prisma, module, wiremockUrl)
      await setupWiremockStub("POST", uniqueWebhookPath, 200, {success: true})

      // When: the first delivery succeeds.
      await processor.handleWebhookAction({data: serializeTenantEvent(event)})

      // Expect: the delivery and its attempt are recorded.
      expect(await getWiremockRequestsFor("POST", uniqueWebhookPath)).toHaveLength(1)
      expect(await prisma.dispatchAttempt.count({where: {organizationId, taskId}})).toBe(1)
      expect(
        await prisma.durableWork.findUniqueOrThrow({where: {organizationId_id: {organizationId, id: taskId}}})
      ).toMatchObject({state: DispatchWorkState.SUCCEEDED})

      // When: the same event reaches the processor again.
      await expect(processor.handleWebhookAction({data: serializeTenantEvent(event)})).resolves.toBeUndefined()

      // Expect: the replay creates no additional delivery or attempt.
      expect(await getWiremockRequestsFor("POST", uniqueWebhookPath)).toHaveLength(1)
      expect(await prisma.dispatchAttempt.count({where: {organizationId, taskId}})).toBe(1)
      expect(
        await prisma.durableWork.findUniqueOrThrow({where: {organizationId_id: {organizationId, id: taskId}}})
      ).toMatchObject({state: DispatchWorkState.SUCCEEDED})
      expect(
        await prisma.tenantEventReceipt.count({
          where: {
            organizationId,
            eventId: event.eventId,
            consumer: "task_dispatch"
          }
        })
      ).toBe(1)
    })

    it("reuses the immutable idempotency key after an accepted webhook loses its persisted outcome", async () => {
      // Given: a delivery reached the receiver, but its worker stopped before recording completion.
      const {taskId, organizationId, event} = await createWorkflowWithWebhookTask(prisma, module, wiremockUrl)
      const context = {organizationId: toOrganizationId(organizationId)}

      await setupWiremockStub("POST", uniqueWebhookPath, 200, {success: true})
      const original = unwrapRight(await taskService.claimDispatch(context, taskId, "webhook", uuidv7())())
      if (original.state !== "admitted") throw new Error("Expected the original webhook to be admitted")
      const task = unwrapRight(await taskService.getWebhookTask(context, taskId)())
      unwrapRight(await taskService.startDispatchExecution(context, original.attemptId, original.lease)())
      unwrapRight(
        await module
          .get(WebhookService)
          .executeWebhook(task.url, task.method, task.headers, task.payload, {idempotencyKey: taskId})()
      )
      // No completion is written. Expiring actual storage ownership reproduces the lost-acknowledgement window.
      await prisma.durableWork.update({
        where: {
          organizationId_id: {organizationId, id: taskId}
        },
        data: {leaseUntil: new Date(0)}
      })

      // Expect: the first request was sent, but its attempt has no recorded outcome.
      const firstRequests = await getWiremockRequestsFor("POST", uniqueWebhookPath)
      expect(firstRequests).toHaveLength(1)
      expect(firstRequests.map(request => request.headers)).toEqual([
        expect.objectContaining({"Idempotency-Key": taskId})
      ])
      expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: original.attemptId}})).toMatchObject({
        state: DispatchAttemptState.EXECUTING
      })

      // When: a replacement execution processes the same committed envelope.
      await processor.handleWebhookAction({data: serializeTenantEvent(event)})

      // Expect: both real requests identify the same immutable task for receiver-side deduplication.
      const requests = await getWiremockRequestsFor("POST", uniqueWebhookPath)
      expect(requests).toHaveLength(2)
      expect(requests.map(request => request.headers)).toEqual([
        expect.objectContaining({"Idempotency-Key": taskId}),
        expect.objectContaining({"Idempotency-Key": taskId})
      ])
      expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: original.attemptId}})).toMatchObject({
        state: DispatchAttemptState.UNKNOWN,
        outcomeCategory: "lease_expired"
      })
      expect(await prisma.dispatchAttempt.count({where: {organizationId, taskId}})).toBe(2)
      expect(
        await prisma.dispatchAttempt.findFirstOrThrow({where: {organizationId, taskId, id: {not: original.attemptId}}})
      ).toMatchObject({state: DispatchAttemptState.SUCCEEDED, outcomeCategory: "http_200"})
      expect(
        await prisma.durableWork.findUniqueOrThrow({
          where: {
            organizationId_id: {organizationId, id: taskId}
          }
        })
      ).toMatchObject({state: DispatchWorkState.SUCCEEDED, attempts: 2})
    })

    it("should successfully process a webhook task and update task status to COMPLETED", async () => {
      // Given: A webhook task in PENDING status
      const {taskId, organizationId, event} = await createWorkflowWithWebhookTask(prisma, module, wiremockUrl)

      // Configure Wiremock to respond to the webhook call
      await setupWiremockStub("POST", uniqueWebhookPath, 200, {success: true, message: "Webhook received"})

      const job = {
        data: serializeTenantEvent(event)
      }

      // When: Process the webhook task
      await processor.handleWebhookAction(job)

      // Expect: The webhook was called
      const wiremockRequests = await getWiremockRequestsFor("POST", uniqueWebhookPath)
      expect(wiremockRequests).toHaveLength(1)

      // And: The task was updated to COMPLETED status
      const updatedTask = await prisma.durableWork.findUnique({
        where: {organizationId_id: {organizationId, id: taskId}}
      })

      expect(updatedTask).toBeDefined()
      expect(updatedTask?.state).toBe(DispatchWorkState.SUCCEEDED)
      expect(await prisma.dispatchAttempt.findFirstOrThrow({where: {organizationId, taskId}})).toMatchObject({
        state: DispatchAttemptState.SUCCEEDED,
        outcomeCategory: "http_200"
      })
      expect(updatedTask?.attempts).toBe(1)
    })

    it("should handle webhook failures and update task status to ERROR", async () => {
      // Given: A webhook task in PENDING status with a failing endpoint
      const {taskId, organizationId, event} = await createWorkflowWithWebhookTask(prisma, module, wiremockUrl)

      // Configure Wiremock to respond with an error
      await setupWiremockStub("POST", uniqueWebhookPath, 500, {error: "Internal Server Error"})

      const job = {
        data: serializeTenantEvent(event)
      }

      // When: Process the webhook task (should succeed and update task to ERROR)
      await processor.handleWebhookAction(job)

      // Expect:The task was updated to ERROR status due to 500 response
      const updatedTask = await prisma.durableWork.findUnique({
        where: {organizationId_id: {organizationId, id: taskId}}
      })

      expect(updatedTask).toBeDefined()
      expect(updatedTask?.state).toBe(DispatchWorkState.FAILED)
      expect(await prisma.dispatchAttempt.findFirstOrThrow({where: {organizationId, taskId}})).toMatchObject({
        state: DispatchAttemptState.FAILED,
        outcomeCategory: "http_500"
      })
      expect(updatedTask?.attempts).toBe(1)

      // And: The webhook was called with retries
      const wiremockRequests = await getWiremockRequestsFor("POST", uniqueWebhookPath)
      // We expect 3 requests total because of the retry mechanism (1 initial + 2 retries)
      expect(wiremockRequests).toHaveLength(3)
    })
  })
})
