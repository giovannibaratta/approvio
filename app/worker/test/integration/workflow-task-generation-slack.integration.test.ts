import {toOrganizationId} from "@test/organization-id"
import {TestingModule} from "@nestjs/testing"
import {WorkflowEventsProcessor} from "../../src/processor/workflow-events.processor"
import {WorkflowStatus, WorkflowActionType, SlackAction} from "@domain"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider, createMockWorkflowTemplateInDb, createMockSpaceInDb} from "@test/mock-data"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {PrismaClient} from "@prisma/client"
import {setupWorkerTestModule} from "./test-helpers"
import {v7 as uuidv7} from "uuid"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {QueueService} from "@services"
import {OUTBOX_REPOSITORY_TOKEN, OutboxRepository} from "@services/durable-work/interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import * as TE from "fp-ts/TaskEither"
import {unwrapRight} from "@utils/either"
import {appendTenantEvent} from "./test-helpers"

describe("WorkflowTaskGeneration - Slack", () => {
  let module: TestingModule
  let processor: WorkflowEventsProcessor
  let prisma: PrismaClient
  let dbUrl: string
  let redisPrefix: string
  let tenantEncryption: TenantEncryptionService
  let outbox: OutboxRepository
  let transactionManager: TenantTransactionManager

  beforeAll(async () => {
    dbUrl = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    const mockConfigProvider = MockConfigProvider.fromOriginalProvider({
      tenantConnectionUrl: dbUrl,
      redisPrefix
    })

    module = await setupWorkerTestModule([WorkflowEventsProcessor])
      .overrideProvider(ConfigProvider)
      .useValue(mockConfigProvider)
      .overrideProvider(QueueService)
      .useValue({enqueue: () => TE.right(undefined)})
      .compile()

    processor = module.get<WorkflowEventsProcessor>(WorkflowEventsProcessor)
    outbox = module.get<OutboxRepository>(OUTBOX_REPOSITORY_TOKEN)
    transactionManager = module.get<TenantTransactionManager>(TRANSACTION_MANAGER_TOKEN)
    prisma = createFixturePrismaClient(dbUrl)
    tenantEncryption = module.get(TenantEncryptionService)
  }, 30000)

  afterAll(async () => {
    await prisma.$disconnect()
    await module?.close()
    await cleanRedisByPrefix(redisPrefix)
  })

  beforeEach(async () => {
    await cleanDatabase(prisma)
  })

  it("should generate a slack task when workflow transitions to a terminal state", async () => {
    // Given
    const workflowId = uuidv7()
    const eventId = uuidv7()

    const action: SlackAction = {
      type: WorkflowActionType.SLACK,
      webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"
    }

    const space = await createMockSpaceInDb(prisma)
    const template = await createMockWorkflowTemplateInDb(prisma, {
      organizationId: space.organizationId,
      spaceId: space.id,
      actions: [action]
    })
    const organizationId = toOrganizationId(template.organizationId)
    const encryptedActions = await tenantEncryption.encrypt(
      {organizationId, resourceType: "workflow_template", resourceId: template.id, field: "actions", formatVersion: 1},
      JSON.stringify([action])
    )()
    if (encryptedActions._tag === "Left") throw new Error("Unable to encrypt test template actions")
    await prisma.workflowTemplate.update({where: {id: template.id}, data: {encActions: encryptedActions.right}})

    await prisma.workflow.create({
      data: {
        id: workflowId,
        organizationId,
        workflowTemplateId: template.id,
        status: "APPROVED",
        name: "Test-Workflow",
        occ: 0n,
        createdAt: new Date(),
        updatedAt: new Date(),
        recalculationRequired: false,
        expiresAt: new Date(Date.now() + 10000)
      }
    })

    const event = {
      schemaVersion: 1 as const,
      eventId,
      workflowId,
      workflowOcc: 0n,
      organizationId,
      type: "workflow.status_changed" as const,
      previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
      status: WorkflowStatus.APPROVED,
      actor: {type: "system" as const, displayName: "slack task test"},
      occurredAt: new Date().toISOString()
    }

    unwrapRight(
      await appendTenantEvent(transactionManager, outbox, {
        ...event,
        schemaVersion: 1,
        workflowOcc: 0n,
        occurredAt: new Date(event.occurredAt)
      })()
    )

    const job = {data: event}

    // When
    await processor.handleWorkflowStatusChanged(job)

    // Expect
    const slackTasks = await prisma.workflowActionsSlackTask.findMany({
      where: {workflowId}
    })

    expect(slackTasks).toHaveLength(1)
    expect(slackTasks[0]?.organizationId).toBe(organizationId)
    expect(slackTasks[0]?.actionIndex).toBe(0)
    expect(slackTasks[0]?.state).toBe("ready")
  })
})
