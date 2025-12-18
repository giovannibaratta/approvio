import {WorkflowActionWebhookProcessor} from "../../src/processor/workflow-action-webhook.processor"
import {TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {createMockSpaceInDb, createMockWorkflowTemplateInDb, MockConfigProvider} from "@test/mock-data"
import {cleanDatabase, prepareDatabase, prepareRedisPrefix, cleanRedisByPrefix} from "@test/database"
import {DatabaseClient} from "@external"
import {PrismaClient, Prisma} from "@prisma/client"
import {setupWorkerTestModule} from "./test-helpers"
import {WorkflowActionWebhookTaskFactory, TaskStatus, WebhookActionHttpMethod, WorkflowStatus} from "@domain"
import {Job} from "bull"
import {WorkflowActionWebhookEvent} from "@domain/events"
import {randomUUID} from "crypto"
import {isLeft} from "fp-ts/lib/Either"
import {createWiremockUrl, getWiremockRequestsFor, setupWiremockStub} from "@test/wiremock"

async function createWorkflowWithWebhookTask(
  prisma: PrismaClient,
  webhookUrl: string,
  method: WebhookActionHttpMethod = WebhookActionHttpMethod.POST,
  headers: Record<string, string> = {"Content-Type": "application/json"},
  payload: unknown = {message: "test payload"}
) {
  // Create a space and template first
  const spaceId = (await createMockSpaceInDb(prisma)).id
  const template = await createMockWorkflowTemplateInDb(prisma, {spaceId})

  // Create a workflow
  const workflow = await prisma.workflow.create({
    data: {
      id: randomUUID(),
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
  const webhookTaskEither = WorkflowActionWebhookTaskFactory.newWorkflowActionWebhookTask({
    id: randomUUID(),
    workflowId: workflow.id,
    url: webhookUrl,
    method,
    headers,
    payload
  })

  if (isLeft(webhookTaskEither)) {
    throw new Error(`Failed to create webhook task for testing: ${JSON.stringify(webhookTaskEither.left)}`)
  }

  const webhookTask = webhookTaskEither.right

  await prisma.workflowActionsWebhookTask.create({
    data: {
      id: webhookTask.id,
      workflowId: webhookTask.workflowId,
      url: webhookTask.url,
      method: webhookTask.method,
      headers: webhookTask.headers as Prisma.InputJsonValue,
      payload: webhookTask.payload as Prisma.InputJsonValue,
      status: webhookTask.status,
      retryCount: webhookTask.retryCount,
      createdAt: webhookTask.createdAt,
      updatedAt: webhookTask.updatedAt,
      occ: webhookTask.occ
    }
  })

  return {workflowId: workflow.id, taskId: webhookTask.id}
}

describe("Workflow Action Webhook Processor Integration", () => {
  let processor: WorkflowActionWebhookProcessor
  let prisma: PrismaClient
  let redisPrefix: string
  let module: TestingModule
  let uniqueWebhookPath: string
  let wiremockUrl: string

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()
    uniqueWebhookPath = `/webhook-${randomUUID()}`
    wiremockUrl = createWiremockUrl(uniqueWebhookPath)

    try {
      const moduleBuilder = setupWorkerTestModule([WorkflowActionWebhookProcessor])
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb, redisPrefix))

      module = await moduleBuilder.compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    processor = module.get<WorkflowActionWebhookProcessor>(WorkflowActionWebhookProcessor)
    prisma = module.get(DatabaseClient)

    // Initialize the module to ensure all providers are ready
    await module.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await cleanRedisByPrefix(redisPrefix)
    await module.close()
  })

  it("should be defined", () => {
    expect(processor).toBeDefined()
  })

  describe("process", () => {
    it("should successfully process a webhook task and update task status to COMPLETED", async () => {
      // Given: A webhook task in PENDING status
      const {taskId, workflowId} = await createWorkflowWithWebhookTask(prisma, wiremockUrl)

      // Configure Wiremock to respond to the webhook call
      await setupWiremockStub("POST", uniqueWebhookPath, 200, {success: true, message: "Webhook received"})

      // Create the event to process
      const event: WorkflowActionWebhookEvent = {
        taskId: taskId,
        workflowId: workflowId
      }

      const job = {
        data: event,
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "test-job-1"
      } as Job<WorkflowActionWebhookEvent>

      // When: Process the webhook task
      await processor.handleWebhookAction(job)

      // Expect: The webhook was called
      const wiremockRequests = await getWiremockRequestsFor("POST", uniqueWebhookPath)
      expect(wiremockRequests).toHaveLength(1)

      // And: The task was updated to COMPLETED status
      const updatedTask = await prisma.workflowActionsWebhookTask.findUnique({
        where: {id: taskId}
      })

      expect(updatedTask).toBeDefined()
      expect(updatedTask?.status).toBe(TaskStatus.COMPLETED)
      expect(updatedTask?.responseStatus).toBe(200)
      // Note: responseBody contains the raw response data as stored by the webhook client
      expect(updatedTask?.responseBody).toBeDefined()
      expect(updatedTask?.retryCount).toBe(0)
      expect(updatedTask?.errorReason).toBeNull()
    })

    it("should handle webhook failures and update task status to ERROR", async () => {
      // Given: A webhook task in PENDING status with a failing endpoint
      const {taskId, workflowId} = await createWorkflowWithWebhookTask(prisma, wiremockUrl)

      // Configure Wiremock to respond with an error
      await setupWiremockStub("POST", uniqueWebhookPath, 500, {error: "Internal Server Error"})

      // Create the event to process
      const event: WorkflowActionWebhookEvent = {
        taskId: taskId,
        workflowId: workflowId
      }

      const job = {
        data: event,
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "test-job-2"
      } as Job<WorkflowActionWebhookEvent>

      // When: Process the webhook task (should succeed and update task to ERROR)
      await processor.handleWebhookAction(job)

      // Expect:The task was updated to ERROR status due to 500 response
      const updatedTask = await prisma.workflowActionsWebhookTask.findUnique({
        where: {id: taskId}
      })

      expect(updatedTask).toBeDefined()
      expect(updatedTask?.status).toBe(TaskStatus.ERROR)
      expect(updatedTask?.responseStatus).toBe(500)
      expect(updatedTask?.retryCount).toBe(1)
      expect(updatedTask?.errorReason).toContain("Webhook returned error status: 500")

      // And: The webhook was called
      const wiremockRequests = await getWiremockRequestsFor("POST", uniqueWebhookPath)
      expect(wiremockRequests).toHaveLength(1)
    })
  })
})
