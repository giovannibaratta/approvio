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
import {InertQueueProvider, setupWorkerTestModule} from "./test-helpers"
import {WorkflowActionWebhookTaskFactory, WebhookActionHttpMethod, WorkflowStatus, TaskReadyEvent} from "@domain"
import {TaskService, WebhookService} from "@services"
import {QUEUE_PROVIDER_TOKEN} from "@services/queue/interface"

import {createWiremockUrl, getWiremockRequestsFor, setupWiremockStub} from "@test/wiremock"
import {v5 as uuidv5, v7 as uuidv7} from "uuid"

const TASK_ID_NAMESPACE = "95650ca4-d361-11f0-8d0d-325096b39f47"
import {unwrapRight} from "@utils/either"

async function createWorkflowWithWebhookTask(
  prisma: PrismaClient,
  taskService: TaskService,
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

  await taskService.createWebhookTask(
    {organizationId: toOrganizationId(template.organizationId)},
    {
      task: webhookTask,
      metadata: {
        eventId: uuidv7(),
        actionIndex: 0,
        availableAt: webhookTask.createdAt
      }
    }
  )()

  return {workflowId: workflow.id, organizationId: template.organizationId, taskId: webhookTask.id}
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

    const moduleBuilder = setupWorkerTestModule([WorkflowActionWebhookProcessor])
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb, redisPrefix))
      .overrideProvider(QUEUE_PROVIDER_TOKEN)
      .useClass(InertQueueProvider)

    module = await moduleBuilder.compile()

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
      const {taskId, organizationId} = await createWorkflowWithWebhookTask(prisma, taskService, wiremockUrl)
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
      await expect(processor.handleWebhookAction({data: forged})).rejects.toThrow("task_not_found")
      // Expect: stored tenant ownership prevents payload loading, attempt creation and external delivery.
      expect(await getWiremockRequestsFor("POST", uniqueWebhookPath)).toHaveLength(0)
      expect(await prisma.dispatchAttempt.count({where: {durableWorkId: taskId}})).toBe(0)
      expect(
        await prisma.durableWork.findUniqueOrThrow({
          where: {
            organizationId_id: {organizationId, id: taskId}
          }
        })
      ).toMatchObject({state: "ready", attempts: 0, fencing: 0n})
    })

    it("does not send a completed task again when its event is replayed", async () => {
      // Given: a persisted webhook task and its committed outbox envelope.
      const {taskId, organizationId} = await createWorkflowWithWebhookTask(prisma, taskService, wiremockUrl)
      await setupWiremockStub("POST", uniqueWebhookPath, 200, {success: true})
      const ready = await prisma.tenantOutbox.findFirstOrThrow({
        where: {
          organizationId,
          resourceId: taskId,
          eventType: "task.ready"
        }
      })
      const event: TaskReadyEvent = {
        schemaVersion: 1,
        eventId: ready.eventId,
        taskOcc: 0n,
        organizationId: toOrganizationId(organizationId),
        taskId,
        taskKind: "webhook",
        type: "task.ready"
      }
      // When: delivery succeeds, then the same event reaches the processor again.
      await processor.handleWebhookAction({data: event})
      await expect(processor.handleWebhookAction({data: event})).rejects.toThrow("lease_lost")
      // Expect: persisted terminal state fences the replay before a second outbound request.
      expect(await getWiremockRequestsFor("POST", uniqueWebhookPath)).toHaveLength(1)
      expect(await prisma.dispatchAttempt.count({where: {organizationId, durableWorkId: taskId}})).toBe(1)
      expect(
        await prisma.tenantEventReceipt.count({
          where: {
            organizationId,
            eventId: ready.eventId,
            consumer: "task_dispatch"
          }
        })
      ).toBe(1)
    })

    it("reuses the immutable idempotency key after an accepted webhook loses its persisted outcome", async () => {
      // Given: a delivery reached the receiver, but its worker stopped before recording completion.
      const {taskId, organizationId} = await createWorkflowWithWebhookTask(prisma, taskService, wiremockUrl)
      const context = {organizationId: toOrganizationId(organizationId)}
      const ready = await prisma.tenantOutbox.findFirstOrThrow({
        where: {
          organizationId,
          resourceId: taskId,
          eventType: "task.ready"
        }
      })
      await setupWiremockStub("POST", uniqueWebhookPath, 200, {success: true})
      const original = unwrapRight(await taskService.claimDispatch(context, taskId, "webhook", uuidv7(), new Date())())
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
      const event: TaskReadyEvent = {
        schemaVersion: 1,
        eventId: ready.eventId,
        taskOcc: 0n,
        organizationId: context.organizationId,
        taskId,
        taskKind: "webhook",
        type: "task.ready"
      }
      // When: a replacement execution processes the same committed envelope.
      await processor.handleWebhookAction({data: event})
      // Expect: both real requests identify the same immutable task for receiver-side deduplication.
      const requests = await getWiremockRequestsFor("POST", uniqueWebhookPath)
      expect(requests).toHaveLength(2)
      expect(requests.map(request => request.headers)).toEqual([
        expect.objectContaining({"Idempotency-Key": taskId}),
        expect.objectContaining({"Idempotency-Key": taskId})
      ])
      expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: original.attemptId}})).toMatchObject({
        state: "unknown",
        outcomeCategory: "lease_expired"
      })
      expect(await prisma.dispatchAttempt.count({where: {organizationId, durableWorkId: taskId}})).toBe(2)
      expect(
        await prisma.durableWork.findUniqueOrThrow({
          where: {
            organizationId_id: {organizationId, id: taskId}
          }
        })
      ).toMatchObject({state: "succeeded", attempts: 2})
    })

    it("should successfully process a webhook task and update task status to COMPLETED", async () => {
      // Given: A webhook task in PENDING status
      const {taskId, organizationId} = await createWorkflowWithWebhookTask(prisma, taskService, wiremockUrl)

      // Configure Wiremock to respond to the webhook call
      await setupWiremockStub("POST", uniqueWebhookPath, 200, {success: true, message: "Webhook received"})

      // Create the event to process
      const event: TaskReadyEvent = {
        schemaVersion: 1,
        eventId: uuidv7(),
        taskOcc: 0n,
        organizationId: toOrganizationId(organizationId),
        taskId,
        taskKind: "webhook",
        type: "task.ready"
      }

      const job = {
        data: event
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
      expect(updatedTask?.state).toBe("succeeded")
      expect(
        await prisma.dispatchAttempt.findFirstOrThrow({where: {organizationId, durableWorkId: taskId}})
      ).toMatchObject({state: "succeeded", outcomeCategory: "http_200"})
      expect(updatedTask?.attempts).toBe(1)
    })

    it("should handle webhook failures and update task status to ERROR", async () => {
      // Given: A webhook task in PENDING status with a failing endpoint
      const {taskId, organizationId} = await createWorkflowWithWebhookTask(prisma, taskService, wiremockUrl)

      // Configure Wiremock to respond with an error
      await setupWiremockStub("POST", uniqueWebhookPath, 500, {error: "Internal Server Error"})

      // Create the event to process
      const event: TaskReadyEvent = {
        schemaVersion: 1,
        eventId: uuidv7(),
        taskOcc: 0n,
        organizationId: toOrganizationId(organizationId),
        taskId,
        taskKind: "webhook",
        type: "task.ready"
      }

      const job = {
        data: event
      }

      // When: Process the webhook task (should succeed and update task to ERROR)
      await processor.handleWebhookAction(job)

      // Expect:The task was updated to ERROR status due to 500 response
      const updatedTask = await prisma.durableWork.findUnique({
        where: {organizationId_id: {organizationId, id: taskId}}
      })

      expect(updatedTask).toBeDefined()
      expect(updatedTask?.state).toBe("failed")
      expect(
        await prisma.dispatchAttempt.findFirstOrThrow({where: {organizationId, durableWorkId: taskId}})
      ).toMatchObject({state: "failed", outcomeCategory: "http_500"})
      expect(updatedTask?.attempts).toBe(1)

      // And: The webhook was called with retries
      const wiremockRequests = await getWiremockRequestsFor("POST", uniqueWebhookPath)
      // We expect 3 requests total because of the retry mechanism (1 initial + 2 retries)
      expect(wiremockRequests).toHaveLength(3)
    })
  })
})
