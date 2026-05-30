import {TestingModule} from "@nestjs/testing"
import {getQueueToken} from "@nestjs/bull"
import {Queue} from "bull"
import {WorkflowEventsProcessor} from "../../src/processor/workflow-events.processor"
import {
  WorkflowStatusChangedEvent,
  WorkflowStatus,
  WorkflowActionType,
  WebhookAction,
  WebhookActionHttpMethod
} from "@domain"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider} from "@test/mock-data"
import {cleanDatabase, prepareDatabase, prepareRedisPrefix, cleanRedisByPrefix} from "@test/database"
import {DatabaseClient, WORKFLOW_STATUS_CHANGED_QUEUE} from "@external"
import {PrismaClient} from "@prisma/client"
import {setupWorkerTestModule} from "./test-helpers"
import {v7 as uuidv7} from "uuid"

describe("WorkflowEventsQueueSerialization Integration", () => {
  let module: TestingModule
  let queue: Queue
  let prisma: PrismaClient
  let dbUrl: string
  let redisPrefix: string

  beforeAll(async () => {
    dbUrl = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    const mockConfigProvider = MockConfigProvider.fromOriginalProvider({
      dbConnectionUrl: dbUrl,
      redisPrefix
    })

    module = await setupWorkerTestModule([WorkflowEventsProcessor])
      .overrideProvider(ConfigProvider)
      .useValue(mockConfigProvider)
      .compile()

    // Initialize module to register Bull queues and start processors
    await module.init()

    queue = module.get<Queue>(getQueueToken(WORKFLOW_STATUS_CHANGED_QUEUE))
    prisma = module.get<DatabaseClient>(DatabaseClient).cx as PrismaClient
  }, 30000)

  afterAll(async () => {
    await module?.close()
    await cleanRedisByPrefix(redisPrefix)
  })

  beforeEach(async () => {
    await cleanDatabase(prisma)
  })

  it("should successfully process enqueued event with date string serialization", async () => {
    // Given
    const spaceId = uuidv7()
    const workflowTemplateId = uuidv7()
    const workflowId = uuidv7()
    const eventId = uuidv7()

    await prisma.space.create({
      data: {id: spaceId, name: "Test Space", occ: 0n, createdAt: new Date(), updatedAt: new Date()}
    })

    const action: WebhookAction = {
      type: WorkflowActionType.WEBHOOK,
      url: "https://example.com/webhook",
      method: WebhookActionHttpMethod.POST
    }

    await prisma.workflowTemplate.create({
      data: {
        id: workflowTemplateId,
        spaceId,
        name: "Test-Template",
        version: 1,
        status: "ACTIVE",
        approvalRule: {
          type: "GROUP_REQUIREMENT",
          groupId: spaceId,
          minCount: 1
        },
        actions: [action],
        occ: 0n,
        allowVotingOnDeprecatedTemplate: false,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })

    await prisma.workflow.create({
      data: {
        id: workflowId,
        workflowTemplateId,
        status: "APPROVED",
        name: "Test-Workflow",
        occ: 0n,
        createdAt: new Date(),
        updatedAt: new Date(),
        recalculationRequired: false,
        expiresAt: new Date(Date.now() + 10000)
      }
    })

    const event: WorkflowStatusChangedEvent = {
      eventId,
      workflowId,
      oldStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
      newStatus: WorkflowStatus.APPROVED,
      workflowTemplateActions: [action],
      timestamp: new Date()
    }

    // When
    // We enqueue the job via the actual Bull queue (which does JSON stringify serialization)
    const job = await queue.add("workflow-status-changed", event)

    // Wait for the job to complete or fail
    await new Promise<void>((resolve, reject) => {
      const onCompleted = (completedJobId: string) => {
        if (completedJobId === job.id.toString()) {
          cleanup()
          resolve()
        }
      }
      const onFailed = (failedJobId: string, err: Error) => {
        if (failedJobId === job.id.toString()) {
          cleanup()
          reject(err)
        }
      }
      const cleanup = () => {
        queue.off("global:completed", onCompleted)
        queue.off("global:failed", onFailed)
      }
      queue.on("global:completed", onCompleted)
      queue.on("global:failed", onFailed)
    })

    // Then
    const webhookTasks = await prisma.workflowActionsWebhookTask.findMany({
      where: {workflowId}
    })

    expect(webhookTasks).toHaveLength(1)
    expect(webhookTasks[0]?.url).toBe(action.url)
    expect(webhookTasks[0]?.status).toBe("PENDING")
  }, 10000)
})
