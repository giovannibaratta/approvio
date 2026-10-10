import {toOrganizationId} from "@test/organization-id"
import {WorkflowActionSlackProcessor} from "../../src/processor/workflow-action-slack.processor"
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
import {setupWorkerTestModule} from "./test-helpers"
import {WorkflowActionSlackTaskFactory, WorkflowStatus, TaskReadyEvent} from "@domain"
import {TaskService} from "@services"

import {createWiremockUrl, getWiremockRequestsFor, setupWiremockStub} from "@test/wiremock"
import {v5 as uuidv5, v7 as uuidv7} from "uuid"

const TASK_ID_NAMESPACE = "95650ca4-d361-11f0-8d0d-325096b39f47"
import {unwrapRight} from "@utils/either"

async function createWorkflowWithSlackTask(
  prisma: PrismaClient,
  taskService: TaskService,
  webhookUrl: string,
  message: string = "Test message"
) {
  const space = await createMockSpaceInDb(prisma)
  const template = await createMockWorkflowTemplateInDb(prisma, {
    organizationId: space.organizationId,
    spaceId: space.id
  })

  const workflow = await prisma.workflow.create({
    data: {
      id: uuidv7(),
      organizationId: template.organizationId,
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
    id: uuidv5(`slack-task-${workflow.id}`, TASK_ID_NAMESPACE),
    organizationId: toOrganizationId(template.organizationId),
    workflowId: workflow.id,
    webhookUrl,
    message
  })

  const task = unwrapRight(taskResult)

  await taskService.createSlackTask(
    {organizationId: toOrganizationId(template.organizationId)},
    {
      task,
      metadata: {
        eventId: uuidv7(),
        actionIndex: 0,
        availableAt: task.createdAt
      }
    }
  )()

  return {workflow, task}
}

describe("WorkflowActionSlackProcessor Integration", () => {
  let module: TestingModule
  let processor: WorkflowActionSlackProcessor
  let prisma: PrismaClient
  let dbUrl: string
  let redisPrefix: string
  let taskService: TaskService
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
      tenantConnectionUrl: dbUrl,
      redisPrefix
    })

    module = await setupWorkerTestModule([WorkflowActionSlackProcessor])
      .overrideProvider(ConfigProvider)
      .useValue(mockConfigProvider)
      .compile()

    processor = module.get<WorkflowActionSlackProcessor>(WorkflowActionSlackProcessor)
    prisma = createFixturePrismaClient(dbUrl)
    taskService = module.get(TaskService)
  }, 30000)

  afterAll(async () => {
    jest.restoreAllMocks()
    await prisma.$disconnect()
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

    const {task} = await createWorkflowWithSlackTask(prisma, taskService, webhookUrl)

    await setupWiremockStub("POST", `/slack-webhook-${mockWebhookId}`, 200, "ok")

    const event: TaskReadyEvent = {
      schemaVersion: 1,
      eventId: uuidv7(),
      taskOcc: 0n,
      organizationId: task.organizationId,
      taskId: task.id,
      taskKind: "slack",
      type: "task.ready"
    }
    const job = {data: event}

    // When
    await processor.handleSlackAction(job)

    // Expect
    const updatedTask = await prisma.durableWork.findUnique({
      where: {organizationId_id: {organizationId: task.organizationId, id: task.id}}
    })

    expect(updatedTask).toBeDefined()
    expect(updatedTask?.state).toBe("succeeded")
    expect(updatedTask?.attempts).toBe(1)

    const requests = await getWiremockRequestsFor("POST", `/slack-webhook-${mockWebhookId}`)
    expect(requests).toHaveLength(1)
  })

  it("should acknowledge a Slack delivery error after persisting an unknown outcome", async () => {
    // Given
    const mockWebhookId = uuidv7()
    const webhookUrl = `${wiremockUrl}/slack-webhook-${mockWebhookId}`

    const {task} = await createWorkflowWithSlackTask(prisma, taskService, webhookUrl)

    await setupWiremockStub("POST", `/slack-webhook-${mockWebhookId}`, 500, "Internal Server Error")

    const event: TaskReadyEvent = {
      schemaVersion: 1,
      eventId: uuidv7(),
      taskOcc: 0n,
      organizationId: task.organizationId,
      taskId: task.id,
      taskKind: "slack",
      type: "task.ready"
    }
    const job = {data: event}

    // When
    // Persist the uncertain delivery outcome and acknowledge the job without retrying the notification.
    await processor.handleSlackAction(job)

    // Expect
    const updatedTask = await prisma.durableWork.findUnique({
      where: {organizationId_id: {organizationId: task.organizationId, id: task.id}}
    })

    expect(updatedTask).toBeDefined()
    expect(updatedTask?.state).toBe("unknown")
    expect(updatedTask?.attempts).toBe(1)
  })
})
