import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {v5 as uuidv5, v7 as uuidv7} from "uuid"
import {TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {Job} from "bull"
import {WorkflowEventsProcessor} from "../../src/processor/workflow-events.processor"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider, createMockWorkflowTemplateInDb, createMockSpaceInDb} from "@test/mock-data"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {TaskService} from "@services"
import {OUTBOX_REPOSITORY_TOKEN, OutboxRepository} from "@services/durable-work/interfaces"
import {QueueService} from "@services"
import * as TE from "fp-ts/TaskEither"
import {EmailAction, WorkflowActionType, WorkflowStatus, WorkflowTaskGenerationEvent, WebhookAction} from "@domain"
import {WebhookActionHttpMethod} from "@domain/workflow-actions"
import {unwrapRight} from "@utils/either"
import {appendTenantEvent, setupWorkerTestModule} from "./test-helpers"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"

type Action = EmailAction | WebhookAction

function emailAction(recipients: string[]): EmailAction {
  return {type: WorkflowActionType.EMAIL, recipients}
}

function webhookAction(url: string, method: WebhookActionHttpMethod = WebhookActionHttpMethod.POST): WebhookAction {
  return {type: WorkflowActionType.WEBHOOK, url, method}
}

async function createWorkflowWithTemplate(
  prisma: PrismaClient,
  tenantEncryption: TenantEncryptionService,
  actions: ReadonlyArray<Action>,
  status: WorkflowStatus = WorkflowStatus.APPROVED
): Promise<{workflowId: string; templateId: string; organizationId: string}> {
  const space = await createMockSpaceInDb(prisma)
  const template = await createMockWorkflowTemplateInDb(prisma, {
    organizationId: space.organizationId,
    spaceId: space.id,
    actions
  })
  const encryptedActions = unwrapRight(
    await tenantEncryption.encrypt(
      {
        organizationId: toOrganizationId(template.organizationId),
        resourceType: "workflow_template",
        resourceId: template.id,
        field: "actions",
        formatVersion: 1
      },
      JSON.stringify(actions)
    )()
  )
  await prisma.workflowTemplate.update({where: {id: template.id}, data: {encActions: encryptedActions}})
  const workflow = await prisma.workflow.create({
    data: {
      id: uuidv7(),
      organizationId: template.organizationId,
      name: `test-workflow-${uuidv7()}`,
      status,
      workflowTemplateId: template.id,
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      updatedAt: new Date(),
      occ: 0n,
      recalculationRequired: false
    }
  })
  return {workflowId: workflow.id, templateId: template.id, organizationId: workflow.organizationId}
}

function statusChangedEvent(
  workflowId: string,
  organizationId: string,
  previousStatus: WorkflowStatus,
  newStatus: WorkflowStatus,
  actions: ReadonlyArray<Action> = []
): WorkflowTaskGenerationEvent {
  return {
    eventId: uuidv7(),
    workflowId,
    organizationId: toOrganizationId(organizationId),
    actor: {type: "system", displayName: "Workflow test"},
    previousStatus,
    newStatus,
    workflowTemplateActions: actions,
    occurredAt: new Date()
  }
}

function job(data: WorkflowTaskGenerationEvent): Pick<Job<unknown>, "data"> {
  return {data: {...data, status: data.newStatus}}
}

describe("Workflow task generation integration", () => {
  let processor: WorkflowEventsProcessor
  let taskService: TaskService
  let outbox: OutboxRepository
  let transactionManager: TenantTransactionManager
  let prisma: PrismaClient
  let redisPrefix: string
  let module: TestingModule
  let tenantEncryption: TenantEncryptionService
  let queue: QueueService
  let ready = false

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()
    module = await setupWorkerTestModule([WorkflowEventsProcessor])
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb, redisPrefix))
      // Queue delivery is covered by the queue serialization/worker integration tests. This suite
      // isolates durable task generation and verifies the rows that the queue will later consume.
      .overrideProvider(QueueService)
      .useValue({enqueue: () => TE.right(undefined)})
      .compile()
    queue = module.get(QueueService)
    processor = module.get(WorkflowEventsProcessor)
    taskService = module.get(TaskService)
    outbox = module.get<OutboxRepository>(OUTBOX_REPOSITORY_TOKEN)
    transactionManager = module.get<TenantTransactionManager>(TRANSACTION_MANAGER_TOKEN)
    tenantEncryption = module.get(TenantEncryptionService)
    prisma = createFixturePrismaClient(isolatedDb)
    await module.init()
    ready = true
  }, 30000)

  afterAll(async () => {
    if (!ready) return
    await prisma.$disconnect()
    await module.close()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    if (!ready) return
    await cleanDatabase(prisma)
    await cleanRedisByPrefix(redisPrefix)
  })

  it("publishes task-ready events only after the task, receipt and outbox commit", async () => {
    const actions = [emailAction(["committed@example.com"])] as const
    const workflow = await createWorkflowWithTemplate(prisma, tenantEncryption, actions)
    const event = statusChangedEvent(
      workflow.workflowId,
      workflow.organizationId,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      WorkflowStatus.APPROVED,
      actions
    )
    await appendStatusEvent(transactionManager, outbox, event)
    const enqueue = jest.spyOn(queue, "enqueue").mockImplementation(readyEvent =>
      TE.tryCatch(
        async () => {
          // An independent connection can see all three facts before enqueue starts.
          expect(await prisma.durableWork.count({where: {organizationId: event.organizationId}})).toBe(1)
          expect(
            await prisma.tenantEventReceipt.count({
              where: {
                organizationId: event.organizationId,
                consumer: "task_generation",
                eventId: event.eventId
              }
            })
          ).toBe(1)
          const row = await prisma.tenantOutbox.findUniqueOrThrow({
            where: {
              organizationId_eventId: {organizationId: readyEvent.organizationId, eventId: readyEvent.eventId}
            }
          })
          expect(row.publishedAt).toBeNull()
        },
        () => "unknown_error" as const
      )
    )

    await processor.handleWorkflowStatusChanged(job(event))

    expect(enqueue).toHaveBeenCalledTimes(1)
    const readyRow = await prisma.tenantOutbox.findFirstOrThrow({
      where: {
        organizationId: event.organizationId,
        eventType: "task.ready"
      }
    })
    expect(readyRow.publishedAt).toBeInstanceOf(Date)
    await processor.handleWorkflowStatusChanged(job(event))
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it("keeps committed tasks and unpublished outbox facts when best-effort enqueue fails", async () => {
    const actions = [emailAction(["recover@example.com"])] as const
    const workflow = await createWorkflowWithTemplate(prisma, tenantEncryption, actions)
    const event = statusChangedEvent(
      workflow.workflowId,
      workflow.organizationId,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      WorkflowStatus.APPROVED,
      actions
    )
    await appendStatusEvent(transactionManager, outbox, event)
    const enqueue = jest.spyOn(queue, "enqueue").mockReturnValue(TE.left("unknown_error"))

    await expect(processor.handleWorkflowStatusChanged(job(event))).resolves.toBeUndefined()

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(await prisma.durableWork.count({where: {organizationId: event.organizationId}})).toBe(1)
    expect(
      await prisma.tenantEventReceipt.count({
        where: {
          organizationId: event.organizationId,
          consumer: "task_generation",
          eventId: event.eventId
        }
      })
    ).toBe(1)
    const readyRow = await prisma.tenantOutbox.findFirstOrThrow({
      where: {
        organizationId: event.organizationId,
        eventType: "task.ready"
      }
    })
    expect(readyRow.publishedAt).toBeNull()
  })

  it("creates encrypted tenant-bound tasks with the event action indexes", async () => {
    const actions = [
      emailAction(["first@example.com"]),
      webhookAction("https://first.example.com/webhook"),
      emailAction(["second@example.com", "team@example.com"]),
      webhookAction("https://second.example.com/webhook", WebhookActionHttpMethod.PUT)
    ] as const
    const workflow = await createWorkflowWithTemplate(prisma, tenantEncryption, actions)
    const event = statusChangedEvent(
      workflow.workflowId,
      workflow.organizationId,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      WorkflowStatus.APPROVED,
      actions
    )
    const changedTemplateActions = unwrapRight(
      await tenantEncryption.encrypt(
        {
          organizationId: toOrganizationId(workflow.organizationId),
          resourceType: "workflow_template",
          resourceId: workflow.templateId,
          field: "actions",
          formatVersion: 1
        },
        JSON.stringify([])
      )()
    )
    await prisma.workflowTemplate.update({
      where: {id: workflow.templateId},
      data: {encActions: changedTemplateActions}
    })

    await appendStatusEvent(transactionManager, outbox, event)
    await processor.handleWorkflowStatusChanged(job(event))

    const emailRows = await prisma.workflowActionsEmailTask.findMany({
      where: {workflowId: workflow.workflowId},
      orderBy: {actionIndex: "asc"}
    })
    const webhookRows = await prisma.workflowActionsWebhookTask.findMany({
      where: {workflowId: workflow.workflowId},
      orderBy: {actionIndex: "asc"}
    })
    expect(emailRows).toHaveLength(2)
    expect(webhookRows).toHaveLength(2)
    expect(emailRows[0]!.organizationId).toBe(workflow.organizationId)
    expect(emailRows[0]!.actionIndex).toBe(0)
    expect(emailRows[1]!.actionIndex).toBe(2)
    expect(webhookRows[0]!.actionIndex).toBe(1)
    expect(webhookRows[1]!.actionIndex).toBe(3)
    expect(emailRows[0]!.state).toBe("ready")
    expect(emailRows[0]!.encPayload).toBeTruthy()
    expect(webhookRows[0]!.encPayload).toBeTruthy()

    const emailTask = unwrapRight(
      await taskService.getEmailTask({organizationId: toOrganizationId(workflow.organizationId)}, emailRows[0]!.id)()
    )
    const webhookTask = unwrapRight(
      await taskService.getWebhookTask(
        {organizationId: toOrganizationId(workflow.organizationId)},
        webhookRows[0]!.id
      )()
    )
    expect(emailTask.recipients).toEqual(["first@example.com"])
    expect(webhookTask.url).toBe("https://first.example.com/webhook")
  })

  it("does not create duplicate tasks when the same event is replayed", async () => {
    const actions = [emailAction(["idempotent@example.com"])] as const
    const workflow = await createWorkflowWithTemplate(prisma, tenantEncryption, actions)
    const event = statusChangedEvent(
      workflow.workflowId,
      workflow.organizationId,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      WorkflowStatus.APPROVED,
      actions
    )
    const eventJob = job(event)

    await appendStatusEvent(transactionManager, outbox, event)
    await Promise.all([
      processor.handleWorkflowStatusChanged(eventJob),
      processor.handleWorkflowStatusChanged(eventJob)
    ])

    const rows = await prisma.workflowActionsEmailTask.findMany({where: {workflowId: workflow.workflowId}})
    expect(rows).toHaveLength(1)
    expect(rows[0]!.eventId).toBe(event.eventId)
    expect(rows[0]!.actionIndex).toBe(0)
    expect(
      await prisma.tenantEventReceipt.count({
        where: {
          organizationId: event.organizationId,
          consumer: "task_generation",
          eventId: event.eventId
        }
      })
    ).toBe(1)
    expect(
      await prisma.tenantOutbox.count({
        where: {
          organizationId: event.organizationId,
          eventType: "task.ready",
          resourceId: rows[0]!.id
        }
      })
    ).toBe(1)
  })

  it("rolls back tasks and the event receipt when any task-ready event conflicts", async () => {
    const enqueue = jest.spyOn(queue, "enqueue")
    const actions = [emailAction(["atomic@example.com"])] as const
    const workflow = await createWorkflowWithTemplate(prisma, tenantEncryption, actions)
    const event = statusChangedEvent(
      workflow.workflowId,
      workflow.organizationId,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      WorkflowStatus.APPROVED,
      actions
    )
    await appendStatusEvent(transactionManager, outbox, event)

    const taskId = uuidv5(`${event.eventId}-${WorkflowActionType.EMAIL}-0`, "95650ca4-d361-11f0-8d0d-325096b39f47")
    const readyEventId = uuidv5(`${event.eventId}:task.ready:${taskId}`, "95650ca4-d361-11f0-8d0d-325096b39f47")
    unwrapRight(
      await appendTenantEvent(transactionManager, outbox, {
        schemaVersion: 1,
        eventId: readyEventId,
        organizationId: event.organizationId,
        type: "workflow.recalculate",
        workflowId: event.workflowId
      })()
    )

    await expect(processor.handleWorkflowStatusChanged(job(event))).rejects.toThrow(
      "Failed to process workflow status change"
    )
    expect(enqueue).not.toHaveBeenCalled()
    expect(await prisma.workflowActionsEmailTask.count({where: {workflowId: workflow.workflowId}})).toBe(0)
    const receiptBeforeRetry = await prisma.$queryRaw<Array<{readonly count: bigint}>>`
      SELECT COUNT(*) AS count FROM tenant_event_receipts
      WHERE organization_id = ${event.organizationId}::uuid AND consumer = 'task_generation'
        AND event_id = ${event.eventId}::uuid
    `
    expect(receiptBeforeRetry[0]?.count).toBe(0n)

    await prisma.tenantOutbox.deleteMany({where: {organizationId: event.organizationId, eventId: readyEventId}})
    await processor.handleWorkflowStatusChanged(job(event))
    expect(await prisma.workflowActionsEmailTask.count({where: {workflowId: workflow.workflowId}})).toBe(1)
    const receiptAfterRetry = await prisma.$queryRaw<Array<{readonly count: bigint}>>`
      SELECT COUNT(*) AS count FROM tenant_event_receipts
      WHERE organization_id = ${event.organizationId}::uuid AND consumer = 'task_generation'
        AND event_id = ${event.eventId}::uuid
    `
    expect(receiptAfterRetry[0]?.count).toBe(1n)
  })

  it("does not generate tasks for an evaluation-in-progress result", async () => {
    const enqueue = jest.spyOn(queue, "enqueue")
    const workflow = await createWorkflowWithTemplate(
      prisma,
      tenantEncryption,
      [emailAction(["ignored@example.com"])],
      WorkflowStatus.EVALUATION_IN_PROGRESS
    )
    const event = statusChangedEvent(
      workflow.workflowId,
      workflow.organizationId,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      [emailAction(["ignored@example.com"])]
    )

    await appendStatusEvent(transactionManager, outbox, event)
    await processor.handleWorkflowStatusChanged(job(event))

    expect(enqueue).not.toHaveBeenCalled()
    expect(await prisma.workflowActionsEmailTask.count({where: {workflowId: workflow.workflowId}})).toBe(0)
  })

  it("rejects a status event without valid status-event attribution", async () => {
    const invalidEvent = {
      eventId: uuidv7(),
      workflowId: uuidv7(),
      organizationId: randomOrgId(),
      previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
      status: WorkflowStatus.APPROVED,
      occurredAt: new Date().toISOString()
    }
    await expect(processor.handleWorkflowStatusChanged({data: invalidEvent})).rejects.toThrow(
      "Missing or invalid actor"
    )
  })
})

async function appendStatusEvent(
  transactionManager: TenantTransactionManager,
  outbox: OutboxRepository,
  event: WorkflowTaskGenerationEvent
): Promise<void> {
  unwrapRight(
    await appendTenantEvent(transactionManager, outbox, {
      schemaVersion: 1,
      eventId: event.eventId,
      organizationId: event.organizationId,
      type: "workflow.status_changed",
      workflowId: event.workflowId,
      workflowOcc: 0n,
      previousStatus: event.previousStatus,
      status: event.newStatus,
      actor: event.actor,
      occurredAt: event.occurredAt
    })()
  )
}
