import {TestingModule} from "@nestjs/testing"
import {Job} from "bull"
import {WorkflowEventsProcessor} from "../../src/processor/workflow-events.processor"
import {WorkflowStatusChangedEvent, WorkflowStatus, WorkflowActionType, SlackAction} from "@domain"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider} from "@test/mock-data"
import {cleanDatabase, prepareDatabase, prepareRedisPrefix, cleanRedisByPrefix} from "@test/database"
import {DatabaseClient} from "@external"
import {PrismaClient} from "@prisma/client"
import {setupWorkerTestModule} from "./test-helpers"
import {v7 as uuidv7} from "uuid"

describe("WorkflowTaskGeneration - Slack", () => {
  let module: TestingModule
  let processor: WorkflowEventsProcessor
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

    processor = module.get<WorkflowEventsProcessor>(WorkflowEventsProcessor)
    prisma = module.get<DatabaseClient>(DatabaseClient).cx as PrismaClient
  }, 30000)

  afterAll(async () => {
    await module?.close()
    await cleanRedisByPrefix(redisPrefix)
  })

  beforeEach(async () => {
    await cleanDatabase(prisma)
  })

  it("should generate a slack task when workflow transitions to a terminal state", async () => {
    // Given
    const spaceId = uuidv7()
    const workflowTemplateId = uuidv7()
    const workflowId = uuidv7()
    const eventId = uuidv7()

    await prisma.space.create({
      data: {id: spaceId, name: "Test Space", occ: 0n, createdAt: new Date(), updatedAt: new Date()}
    })

    const action: SlackAction = {
      type: WorkflowActionType.SLACK,
      webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"
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

    const job = {data: event} as Job<WorkflowStatusChangedEvent>

    // When
    await processor.handleWorkflowStatusChanged(job)

    // Expect
    const slackTasks = await prisma.workflowActionsSlackTask.findMany({
      where: {workflowId}
    })

    expect(slackTasks).toHaveLength(1)
    expect(slackTasks[0]?.webhookUrl).toBe(action.webhookUrl)
    expect(slackTasks[0]?.status).toBe("PENDING")
  })
})
