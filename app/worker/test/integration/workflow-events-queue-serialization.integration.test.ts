import {toOrganizationId} from "@test/organization-id"
import {TestingModule} from "@nestjs/testing"
import {getQueueToken} from "@nestjs/bull"
import {Queue} from "bull"
import {WorkflowEventsProcessor} from "../../src/processor/workflow-events.processor"
import {WorkflowStatus, WorkflowActionType, WebhookAction, WebhookActionHttpMethod} from "@domain"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider, createMockWorkflowTemplateInDb, createMockSpaceInDb} from "@test/mock-data"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {WORKFLOW_STATUS_CHANGED_QUEUE} from "@external"
import {PrismaClient} from "@prisma/client"
import {setupWorkerTestModule} from "./test-helpers"
import {appendTenantEvent} from "./test-helpers"
import {OUTBOX_REPOSITORY_TOKEN, OutboxRepository} from "@services/durable-work/interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {QUEUE_PROVIDER_TOKEN, QueueProvider} from "@services/queue/interface"

describe("WorkflowEventsQueueSerialization Integration", () => {
  let module: TestingModule
  let queue: Queue
  let prisma: PrismaClient
  let dbUrl: string
  let redisPrefix: string
  let tenantEncryption: TenantEncryptionService
  let outbox: OutboxRepository
  let transactionManager: TenantTransactionManager
  let queueProvider: QueueProvider

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
      .compile()

    // Initialize module to register Bull queues and start processors
    await module.init()

    queue = module.get<Queue>(getQueueToken(WORKFLOW_STATUS_CHANGED_QUEUE))
    prisma = createFixturePrismaClient(dbUrl)
    tenantEncryption = module.get(TenantEncryptionService)
    outbox = module.get<OutboxRepository>(OUTBOX_REPOSITORY_TOKEN)
    transactionManager = module.get<TenantTransactionManager>(TRANSACTION_MANAGER_TOKEN)
    queueProvider = module.get<QueueProvider>(QUEUE_PROVIDER_TOKEN)
  }, 30000)

  afterAll(async () => {
    await prisma.$disconnect()
    await module?.close()
    await cleanRedisByPrefix(redisPrefix)
  })

  beforeEach(async () => {
    await cleanDatabase(prisma)
  })

  it("should successfully process enqueued event with date string serialization", async () => {
    // Given
    const workflowId = uuidv7()
    const eventId = uuidv7()

    const action: WebhookAction = {
      type: WorkflowActionType.WEBHOOK,
      url: "https://example.com/webhook",
      method: WebhookActionHttpMethod.POST
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
      actor: {type: "system" as const, displayName: "queue test"},
      occurredAt: new Date()
    }

    unwrapRight(await appendTenantEvent(transactionManager, outbox, event)())
    unwrapRight(await queueProvider.enqueue(event)())

    // When
    // Publication follows the committed outbox write and uses the production queue routing.
    const job = await queue.getJob(`${organizationId}:${eventId}:0`)
    if (!job) throw new Error("Queue provider did not create the status-change job")
    expect(job.name).toBe("workflow-status-changed")
    await job.finished()

    // Then
    const webhookTasks = await prisma.workflowActionsWebhookTask.findMany({
      where: {workflowId}
    })

    expect(webhookTasks).toHaveLength(1)
    expect(webhookTasks[0]?.organizationId).toBe(organizationId)
    expect(webhookTasks[0]?.actionIndex).toBe(0)
    expect(webhookTasks[0]?.state).toBe("ready")
  }, 10000)
})
