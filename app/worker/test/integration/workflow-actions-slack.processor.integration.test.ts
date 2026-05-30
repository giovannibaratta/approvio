import {WorkflowActionSlackProcessor} from "../../src/processor/workflow-action-slack.processor"
import {TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {createMockSpaceInDb, createMockWorkflowTemplateInDb, MockConfigProvider} from "@test/mock-data"
import {cleanDatabase, prepareDatabase, prepareRedisPrefix, cleanRedisByPrefix} from "@test/database"
import {DatabaseClient} from "@external"
import {PrismaClient} from "@prisma/client"
import {setupWorkerTestModule} from "./test-helpers"
import {WorkflowActionSlackTaskFactory, TaskStatus, ResponseBodyStatus, WorkflowStatus} from "@domain"
import {Job} from "bull"
import {WorkflowActionSlackEvent} from "@domain"

import {createWiremockUrl, getWiremockRequestsFor, setupWiremockStub} from "@test/wiremock"
import {v7 as uuidv7} from "uuid"
import {unwrapRight} from "@utils/either"

async function createWorkflowWithSlackTask(prisma: PrismaClient, webhookUrl: string, message: string = "Test message") {
  const spaceId = (await createMockSpaceInDb(prisma)).id
  const template = await createMockWorkflowTemplateInDb(prisma, {spaceId})

  const workflow = await prisma.workflow.create({
    data: {
      id: uuidv7(),
      workflowTemplateId: template.id,
      name: "Slack-Workflow",
      status: WorkflowStatus.EVALUATION_IN_PROGRESS,
      recalculationRequired: false,
      expiresAt: new Date(Date.now() + 100000),
      occ: 0n,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  })

  const taskResult = WorkflowActionSlackTaskFactory.newWorkflowActionSlackTask({
    id: uuidv7(),
    workflowId: workflow.id,
    webhookUrl,
    message
  })

  const task = unwrapRight(taskResult)

  const createdTask = await prisma.workflowActionsSlackTask.create({
    data: {
      id: task.id,
      workflowId: task.workflowId,
      status: task.status,
      webhookUrl: task.webhookUrl,
      message: task.message,
      retryCount: task.retryCount,
      occ: task.occ,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    }
  })

  return {workflow, task: createdTask}
}

describe("WorkflowActionSlackProcessor Integration", () => {
  let module: TestingModule
  let processor: WorkflowActionSlackProcessor
  let prisma: PrismaClient
  let dbUrl: string
  let redisPrefix: string
  const wiremockUrl = createWiremockUrl("")

  beforeAll(async () => {
    jest.spyOn(WorkflowActionSlackTaskFactory, "isValidSlackWebhookUrl").mockImplementation(url => {
      return (
        url.startsWith("https://hooks.slack.com") ||
        url.startsWith("http://localhost") ||
        url.startsWith("http://127.0.0.1")
      )
    })

    dbUrl = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    const mockConfigProvider = MockConfigProvider.fromOriginalProvider({
      dbConnectionUrl: dbUrl,
      redisPrefix
    })

    module = await setupWorkerTestModule([WorkflowActionSlackProcessor])
      .overrideProvider(ConfigProvider)
      .useValue(mockConfigProvider)
      .compile()

    processor = module.get<WorkflowActionSlackProcessor>(WorkflowActionSlackProcessor)
    prisma = module.get<DatabaseClient>(DatabaseClient).cx as PrismaClient
  }, 30000)

  afterAll(async () => {
    jest.restoreAllMocks()
    await module?.close()
    await cleanRedisByPrefix(redisPrefix)
  })

  beforeEach(async () => {
    await cleanDatabase(prisma)
  })

  it("should successfully process a slack task and mark it as COMPLETED", async () => {
    // Given
    const mockWebhookId = uuidv7()
    const webhookUrl = `${wiremockUrl}/slack-webhook-${mockWebhookId}`

    const {task} = await createWorkflowWithSlackTask(prisma, webhookUrl)

    await setupWiremockStub("POST", `/slack-webhook-${mockWebhookId}`, 200, "ok")

    const job = {
      data: {taskId: task.id, workflowId: task.workflowId}
    } as Job<WorkflowActionSlackEvent>

    // When
    await processor.handleSlackAction(job)

    // Expect
    const updatedTask = await prisma.workflowActionsSlackTask.findUnique({
      where: {id: task.id}
    })

    expect(updatedTask).toBeDefined()
    expect(updatedTask?.status).toBe(TaskStatus.COMPLETED)
    expect(updatedTask?.responseStatus).toBe(200)
    expect(updatedTask?.responseBody).toBe("ok")
    expect(updatedTask?.responseBodyStatus).toBe(ResponseBodyStatus.OK)
    expect(updatedTask?.retryCount).toBe(0)
    expect(updatedTask?.errorReason).toBeNull()

    const requests = await getWiremockRequestsFor("POST", `/slack-webhook-${mockWebhookId}`)
    expect(requests).toHaveLength(1)
  })

  it("should process a failing slack task and mark it as ERROR", async () => {
    // Given
    const mockWebhookId = uuidv7()
    const webhookUrl = `${wiremockUrl}/slack-webhook-${mockWebhookId}`

    const {task} = await createWorkflowWithSlackTask(prisma, webhookUrl)

    await setupWiremockStub("POST", `/slack-webhook-${mockWebhookId}`, 500, "Internal Server Error")

    const job = {
      data: {taskId: task.id, workflowId: task.workflowId}
    } as Job<WorkflowActionSlackEvent>

    // When
    await processor.handleSlackAction(job)

    // Expect
    const updatedTask = await prisma.workflowActionsSlackTask.findUnique({
      where: {id: task.id}
    })

    expect(updatedTask).toBeDefined()
    expect(updatedTask?.status).toBe(TaskStatus.ERROR)
    expect(updatedTask?.responseStatus).toBeNull()
    expect(updatedTask?.errorReason).toBe("Slack execution failed: slack_request_failed")
    expect(updatedTask?.retryCount).toBe(1)
  })
})
