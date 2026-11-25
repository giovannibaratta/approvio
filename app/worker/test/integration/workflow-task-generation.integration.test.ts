import {v5 as uuidv5, v7 as uuidv7} from "uuid"
import {WorkflowEventsProcessor} from "../../src/processor/workflow-events.processor"
import {TestingModule} from "@nestjs/testing"
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
import {Job} from "bull"
import {
  TASK_ID_NAMESPACE,
  EmailAction,
  WorkflowActionType,
  WorkflowStatus,
  WorkflowStatusChangedEvent,
  WebhookAction
} from "@domain"
import {WebhookActionHttpMethod} from "@domain/workflow-actions"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {Logger} from "@nestjs/common"
import {TaskService, QueueService} from "@services"
import {TENANT_OUTBOX_REPOSITORY_TOKEN, TenantOutboxRepository} from "@services/durable-work/interfaces"
import * as TE from "fp-ts/TaskEither"
import {unwrapRight} from "@utils/either"
import {appendTenantEvent, setupWorkerTestModule} from "./test-helpers"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"

type Action = EmailAction | WebhookAction

async function createWorkflowWithTemplate(
  prisma: PrismaClient,
  config: {
    workflowName: string
    workflowStatus: WorkflowStatus
    actions: ReadonlyArray<EmailAction | WebhookAction>
  },
  tenantEncryption: TenantEncryptionService
): Promise<{
  workflowId: string
  templateId: string
  spaceId: string
  organizationId: string
  actions: ReadonlyArray<EmailAction | WebhookAction>
}> {
  const space = await createMockSpaceInDb(prisma)
  const template = await createMockWorkflowTemplateInDb(prisma, {
    organizationId: space.organizationId,
    spaceId: space.id,
    actions: config.actions
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
      JSON.stringify(config.actions)
    )()
  )
  await prisma.workflowTemplate.update({where: {id: template.id}, data: {encActions: encryptedActions}})
  const workflow = await prisma.workflow.create({
    data: {
      id: uuidv7(),
      organizationId: template.organizationId,
      name: config.workflowName,
      status: config.workflowStatus,
      workflowTemplateId: template.id,
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      updatedAt: new Date(),
      occ: 0n,
      recalculationRequired: false
    }
  })
  return {
    workflowId: workflow.id,
    templateId: template.id,
    spaceId: space.id,
    organizationId: workflow.organizationId,
    actions: config.actions
  }
}

function createEmailAction(recipients: string[]): EmailAction {
  return {
    type: WorkflowActionType.EMAIL,
    recipients
  }
}

function createWebhookAction(
  url: string,
  method: WebhookActionHttpMethod = WebhookActionHttpMethod.POST,
  headers?: Record<string, string>
): WebhookAction {
  return {
    type: WorkflowActionType.WEBHOOK,
    url,
    method,
    headers
  }
}

function statusChangedEvent(
  workflowId: string,
  organizationId: string,
  previousStatus: WorkflowStatus,
  newStatus: WorkflowStatus,
  actions: ReadonlyArray<Action> = []
): WorkflowStatusChangedEvent {
  return {
    schemaVersion: 1,
    type: "workflow.status_changed",
    workflowOcc: 0n,
    eventId: uuidv7(),
    workflowId,
    organizationId: toOrganizationId(organizationId),
    actor: {type: "system", displayName: "Workflow test"},
    previousStatus,
    status: newStatus,
    workflowTemplateActions: actions,
    occurredAt: new Date()
  }
}

function job(data: WorkflowStatusChangedEvent): Pick<Job<unknown>, "data"> {
  return {data}
}

describe("Workflow Task Generation Integration", () => {
  let processor: WorkflowEventsProcessor
  let taskService: TaskService
  let outbox: TenantOutboxRepository
  let transactionManager: TenantTransactionManager
  let prisma: PrismaClient
  let redisPrefix: string
  let module: TestingModule
  let tenantEncryption: TenantEncryptionService
  let queue: QueueService

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
    outbox = module.get<TenantOutboxRepository>(TENANT_OUTBOX_REPOSITORY_TOKEN)
    transactionManager = module.get<TenantTransactionManager>(TRANSACTION_MANAGER_TOKEN)
    tenantEncryption = module.get(TenantEncryptionService)
    prisma = createFixturePrismaClient(isolatedDb)
    await module.init()
  }, 30000)

  afterAll(async () => {
    await prisma.$disconnect()
    await module.close()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await cleanDatabase(prisma)
    await cleanRedisByPrefix(redisPrefix)
  })

  it("should be defined", () => {
    expect(processor).toBeDefined()
  })

  describe("handleWorkflowStatusChanged", () => {
    describe("good cases", () => {
      it("should create EMAIL and WEBHOOK tasks when workflow is approved", async () => {
        // Given: A workflow with EMAIL and WEBHOOK actions
        const {workflowId, organizationId, actions} = await createWorkflowWithTemplate(
          prisma,
          {
            workflowName: "Test-Workflow-With-Actions",
            workflowStatus: WorkflowStatus.APPROVED,
            actions: [
              createEmailAction(["test@example.com"]),
              createWebhookAction("https://example.com/webhook", WebhookActionHttpMethod.POST)
            ]
          },
          tenantEncryption
        )
        const event: WorkflowStatusChangedEvent = {
          schemaVersion: 1,
          type: "workflow.status_changed",
          workflowOcc: 0n,
          eventId: uuidv7(),
          workflowId,
          organizationId: toOrganizationId(organizationId),
          actor: {type: "system", displayName: "Workflow test"},
          previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          status: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          occurredAt: new Date()
        }
        await appendStatusEvent(transactionManager, outbox, event)
        const job = {data: event}

        // When
        await processor.handleWorkflowStatusChanged(job)

        // Expect: EMAIL task created
        const emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(1)
        expect(emailTasks[0]!.state).toBe("ready")
        const context = {organizationId: toOrganizationId(organizationId)}
        const email = unwrapRight(await taskService.getEmailTask(context, emailTasks[0]!.id)())
        expect(email.recipients).toEqual(["test@example.com"])
        expect(email.subject).toBe("Workflow Test-Workflow-With-Actions status update")
        expect(email.body).toContain(
          "The workflow Test-Workflow-With-Actions has transitioned from EVALUATION_IN_PROGRESS to APPROVED"
        )

        // And: WEBHOOK task created
        const webhookTasks = await prisma.workflowActionsWebhookTask.findMany({where: {workflowId}})
        expect(webhookTasks).toHaveLength(1)
        expect(webhookTasks[0]!.state).toBe("ready")
        const webhook = unwrapRight(await taskService.getWebhookTask(context, webhookTasks[0]!.id)())
        expect(webhook).toMatchObject({url: "https://example.com/webhook", method: WebhookActionHttpMethod.POST})
      })

      it("should create multiple EMAIL tasks when multiple EMAIL actions are defined", async () => {
        // Given: A workflow with multiple EMAIL actions
        const {workflowId, organizationId, actions} = await createWorkflowWithTemplate(
          prisma,
          {
            workflowName: "Test-Multiple-Emails",
            workflowStatus: WorkflowStatus.APPROVED,
            actions: [
              createEmailAction(["admin@example.com"]),
              createEmailAction(["user@example.com", "team@example.com"]),
              createEmailAction(["ops@example.com"])
            ]
          },
          tenantEncryption
        )
        const event: WorkflowStatusChangedEvent = {
          schemaVersion: 1,
          type: "workflow.status_changed",
          workflowOcc: 0n,
          eventId: uuidv7(),
          workflowId,
          organizationId: toOrganizationId(organizationId),
          actor: {type: "system", displayName: "Workflow test"},
          previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          status: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          occurredAt: new Date()
        }
        await appendStatusEvent(transactionManager, outbox, event)
        const job = {data: event}

        // When
        await processor.handleWorkflowStatusChanged(job)

        // Expect: 3 EMAIL tasks created
        const emailTasks = await prisma.workflowActionsEmailTask.findMany({
          where: {workflowId},
          orderBy: {actionIndex: "asc"}
        })
        expect(emailTasks).toHaveLength(3)
        const context = {organizationId: toOrganizationId(organizationId)}
        const tasks = await Promise.all(
          emailTasks.map(async task => unwrapRight(await taskService.getEmailTask(context, task.id)()))
        )
        const allRecipients = tasks.map(task => task.recipients)

        // Verify all expected recipient groups are present (order doesn't matter)
        expect(allRecipients).toContainEqual(["admin@example.com"])
        expect(allRecipients).toContainEqual(["user@example.com", "team@example.com"])
        expect(allRecipients).toContainEqual(["ops@example.com"])

        // Check subject and body for one task
        const firstTask = tasks[0]!
        expect(firstTask.subject).toBe("Workflow Test-Multiple-Emails status update")
        expect(firstTask.body).toContain(
          "The workflow Test-Multiple-Emails has transitioned from EVALUATION_IN_PROGRESS to APPROVED"
        )
      })

      it("should create multiple WEBHOOK tasks with different configurations", async () => {
        // Given: A workflow with multiple WEBHOOK actions
        const {workflowId, organizationId, actions} = await createWorkflowWithTemplate(
          prisma,
          {
            workflowName: "Test-Multiple-Webhooks",
            workflowStatus: WorkflowStatus.APPROVED,
            actions: [
              createWebhookAction("https://api1.example.com/hook", WebhookActionHttpMethod.POST),
              createWebhookAction("https://api2.example.com/hook", WebhookActionHttpMethod.PUT, {
                "X-Custom-Header": "value1"
              }),
              createWebhookAction("https://api3.example.com/hook", WebhookActionHttpMethod.GET)
            ]
          },
          tenantEncryption
        )
        const event: WorkflowStatusChangedEvent = {
          schemaVersion: 1,
          type: "workflow.status_changed",
          workflowOcc: 0n,
          eventId: uuidv7(),
          workflowId,
          organizationId: toOrganizationId(organizationId),
          actor: {type: "system", displayName: "Workflow test"},
          previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          status: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          occurredAt: new Date()
        }
        await appendStatusEvent(transactionManager, outbox, event)
        const job = {data: event}

        // When
        await processor.handleWorkflowStatusChanged(job)

        // Expect: 3 WEBHOOK tasks created
        const webhookTasks = await prisma.workflowActionsWebhookTask.findMany({
          where: {workflowId},
          orderBy: {actionIndex: "asc"}
        })
        expect(webhookTasks).toHaveLength(3)
        const context = {organizationId: toOrganizationId(organizationId)}
        const tasks = await Promise.all(
          webhookTasks.map(async task => unwrapRight(await taskService.getWebhookTask(context, task.id)()))
        )
        expect(tasks[0]).toMatchObject({url: "https://api1.example.com/hook", method: WebhookActionHttpMethod.POST})
        expect(tasks[0]?.headers).toBeUndefined()
        expect(tasks[1]).toMatchObject({
          url: "https://api2.example.com/hook",
          method: WebhookActionHttpMethod.PUT,
          headers: {"X-Custom-Header": "value1"}
        })
        expect(tasks[2]).toMatchObject({url: "https://api3.example.com/hook", method: WebhookActionHttpMethod.GET})
      })

      it("should be idempotent (processing the same event twice should not create duplicate tasks)", async () => {
        // Given: A workflow definition
        const {workflowId, organizationId, actions} = await createWorkflowWithTemplate(
          prisma,
          {
            workflowName: "Test-Idempotency",
            workflowStatus: WorkflowStatus.APPROVED,
            actions: [createEmailAction(["idempotency@example.com"])]
          },
          tenantEncryption
        )
        const event: WorkflowStatusChangedEvent = {
          schemaVersion: 1,
          type: "workflow.status_changed",
          workflowOcc: 0n,
          eventId: uuidv7(),
          workflowId,
          organizationId: toOrganizationId(organizationId),
          actor: {type: "system", displayName: "Workflow test"},
          previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          status: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          occurredAt: new Date()
        }
        await appendStatusEvent(transactionManager, outbox, event)
        const job = {data: event}

        // When: Processed once
        await processor.handleWorkflowStatusChanged(job)

        // Expect: Task created
        let emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(1)
        const firstTaskId = emailTasks[0]!.id

        // When: Processed a second time
        await processor.handleWorkflowStatusChanged(job)

        // Expect: Still only one task, same ID
        emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(1)
        expect(emailTasks[0]!.id).toBe(firstTaskId)
      })

      it("recreates a missing generation receipt without republishing an existing task", async () => {
        // Given
        const actions = [createEmailAction(["recovery@example.com"])] as const
        const workflow = await createWorkflowWithTemplate(
          prisma,
          {workflowName: `test-workflow-${uuidv7()}`, workflowStatus: WorkflowStatus.APPROVED, actions},
          tenantEncryption
        )
        const event = statusChangedEvent(
          workflow.workflowId,
          workflow.organizationId,
          WorkflowStatus.EVALUATION_IN_PROGRESS,
          WorkflowStatus.APPROVED,
          actions
        )
        await appendStatusEvent(transactionManager, outbox, event)
        await processor.handleWorkflowStatusChanged(job(event))
        const receipt = {organizationId: event.organizationId, eventId: event.eventId, consumer: "task_generation"}
        await prisma.tenantEventReceipt.deleteMany({where: receipt})
        const enqueue = jest.spyOn(queue, "enqueue")

        // When
        await processor.handleWorkflowStatusChanged(job(event))

        // Expect
        expect(await prisma.workflowActionsEmailTask.count({where: {workflowId: workflow.workflowId}})).toBe(1)
        expect(await prisma.tenantEventReceipt.count({where: receipt})).toBe(1)
        expect(enqueue).not.toHaveBeenCalled()
      })

      it("rolls back tasks and the event receipt when any task-ready event conflicts", async () => {
        // Given
        const enqueue = jest.spyOn(queue, "enqueue")
        const actions = [
          createEmailAction(["recovery@example.com"]),
          createWebhookAction("https://recovery.example.com")
        ] as const
        const workflow = await createWorkflowWithTemplate(
          prisma,
          {workflowName: `test-workflow-${uuidv7()}`, workflowStatus: WorkflowStatus.APPROVED, actions},
          tenantEncryption
        )
        const event: WorkflowStatusChangedEvent = {
          schemaVersion: 1,
          type: "workflow.status_changed",
          workflowOcc: 0n,
          eventId: uuidv7(),
          workflowId: workflow.workflowId,
          organizationId: toOrganizationId(workflow.organizationId),
          actor: {type: "system", displayName: "Workflow test"},
          previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          status: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          occurredAt: new Date()
        }
        await appendStatusEvent(transactionManager, outbox, event)
        const job = {data: event}

        const taskId = uuidv5(`${event.eventId}-${WorkflowActionType.EMAIL}-0`, TASK_ID_NAMESPACE)
        const readyEventId = uuidv5(`${event.eventId}:task.ready:${taskId}`, TASK_ID_NAMESPACE)
        unwrapRight(
          await appendTenantEvent(transactionManager, outbox, {
            schemaVersion: 1,
            eventId: readyEventId,
            organizationId: event.organizationId,
            type: "workflow.recalculate",
            workflowId: event.workflowId
          })()
        )

        // When
        const result = processor.handleWorkflowStatusChanged(job)
        // Expect
        await expect(result).rejects.toThrow("Failed to process workflow status change")
        expect(enqueue).not.toHaveBeenCalled()
        expect(await prisma.workflowActionsEmailTask.count({where: {workflowId: workflow.workflowId}})).toBe(0)
        expect(await prisma.workflowActionsWebhookTask.count({where: {workflowId: workflow.workflowId}})).toBe(0)
        const receiptBeforeRetry = await prisma.$queryRaw<Array<{readonly count: bigint}>>`
          SELECT COUNT(*) AS count FROM tenant_event_receipts
          WHERE organization_id = ${event.organizationId}::uuid AND consumer = 'task_generation'
            AND event_id = ${event.eventId}::uuid
        `
        expect(receiptBeforeRetry[0]?.count).toBe(0n)

        await prisma.tenantOutbox.deleteMany({where: {organizationId: event.organizationId, eventId: readyEventId}})
        // When
        await processor.handleWorkflowStatusChanged(job)
        // Expect
        expect(await prisma.workflowActionsEmailTask.count({where: {workflowId: workflow.workflowId}})).toBe(1)
        expect(await prisma.workflowActionsWebhookTask.count({where: {workflowId: workflow.workflowId}})).toBe(1)
        const receiptAfterRetry = await prisma.$queryRaw<Array<{readonly count: bigint}>>`
          SELECT COUNT(*) AS count FROM tenant_event_receipts
          WHERE organization_id = ${event.organizationId}::uuid AND consumer = 'task_generation'
            AND event_id = ${event.eventId}::uuid
        `
        expect(receiptAfterRetry[0]?.count).toBe(1n)
      })

      it("should create tasks when workflow is rejected", async () => {
        // Given: A workflow transitioning to REJECTED status
        const {workflowId, organizationId, actions} = await createWorkflowWithTemplate(
          prisma,
          {
            workflowName: "Test-Rejected-Workflow",
            workflowStatus: WorkflowStatus.REJECTED,
            actions: [createEmailAction(["rejection@example.com"])]
          },
          tenantEncryption
        )

        const event: WorkflowStatusChangedEvent = {
          schemaVersion: 1,
          type: "workflow.status_changed",
          workflowOcc: 0n,
          eventId: uuidv7(),
          workflowId,
          organizationId: toOrganizationId(organizationId),
          actor: {type: "system", displayName: "Workflow test"},
          previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          status: WorkflowStatus.REJECTED,
          workflowTemplateActions: actions,
          occurredAt: new Date()
        }
        await appendStatusEvent(transactionManager, outbox, event)

        const job = {data: event}

        // When
        await processor.handleWorkflowStatusChanged(job)

        // Expect: EMAIL task created
        const emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(1)
      })

      it("should not create tasks when workflow status is EVALUATION_IN_PROGRESS", async () => {
        // Given: A workflow in EVALUATION_IN_PROGRESS status
        const enqueue = jest.spyOn(queue, "enqueue")
        const {workflowId, organizationId, actions} = await createWorkflowWithTemplate(
          prisma,
          {
            workflowName: "Test-In-Progress",
            workflowStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
            actions: [createEmailAction(["test@example.com"])]
          },
          tenantEncryption
        )
        const event: WorkflowStatusChangedEvent = {
          schemaVersion: 1,
          type: "workflow.status_changed",
          workflowOcc: 0n,
          eventId: uuidv7(),
          workflowId,
          organizationId: toOrganizationId(organizationId),
          actor: {type: "system", displayName: "Workflow test"},
          previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          status: WorkflowStatus.EVALUATION_IN_PROGRESS,
          workflowTemplateActions: actions,
          occurredAt: new Date()
        }

        await appendStatusEvent(transactionManager, outbox, event)
        const job = {data: event}
        // When
        await processor.handleWorkflowStatusChanged(job)

        // Expect: No tasks created
        expect(enqueue).not.toHaveBeenCalled()
        const emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        const webhookTasks = await prisma.workflowActionsWebhookTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(0)
        expect(webhookTasks).toHaveLength(0)
      })

      it("should not create tasks when template has no actions", async () => {
        // Given: A workflow with a template that has no actions
        const {workflowId, organizationId, actions} = await createWorkflowWithTemplate(
          prisma,
          {workflowName: "Test-No-Actions", workflowStatus: WorkflowStatus.APPROVED, actions: []},
          tenantEncryption
        )
        const event: WorkflowStatusChangedEvent = {
          schemaVersion: 1,
          type: "workflow.status_changed",
          workflowOcc: 0n,
          eventId: uuidv7(),
          workflowId,
          organizationId: toOrganizationId(organizationId),
          actor: {type: "system", displayName: "Workflow test"},
          previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          status: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          occurredAt: new Date()
        }
        await appendStatusEvent(transactionManager, outbox, event)
        const job = {data: event}

        // When
        await processor.handleWorkflowStatusChanged(job)

        // Expect: No tasks created
        const emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        const webhookTasks = await prisma.workflowActionsWebhookTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(0)
        expect(webhookTasks).toHaveLength(0)
      })

      it("should use snapshot actions from event instead of updated template actions in DB", async () => {
        // Given: A workflow with initial actions
        const initialActions = [
          createEmailAction(["initial@example.com"]),
          createWebhookAction("https://initial.example.com/webhook")
        ]
        const {workflowId, templateId, organizationId} = await createWorkflowWithTemplate(
          prisma,
          {workflowName: "Test-Snapshot-Actions", workflowStatus: WorkflowStatus.APPROVED, actions: initialActions},
          tenantEncryption
        )

        // And: The template has been updated with different actions in the DB
        const updatedActions = [
          createEmailAction(["updated@example.com", "another@example.com"]),
          createWebhookAction("https://updated.example.com/webhook", WebhookActionHttpMethod.PUT)
        ]
        const encryptedActions = unwrapRight(
          await tenantEncryption.encrypt(
            {
              organizationId: toOrganizationId(organizationId),
              resourceType: "workflow_template",
              resourceId: templateId,
              field: "actions",
              formatVersion: 1
            },
            JSON.stringify(updatedActions)
          )()
        )
        await prisma.workflowTemplate.update({where: {id: templateId}, data: {encActions: encryptedActions}})

        // And: An event with the snapshot of the initial actions
        const event: WorkflowStatusChangedEvent = {
          schemaVersion: 1,
          type: "workflow.status_changed",
          workflowOcc: 0n,
          eventId: uuidv7(),
          workflowId,
          organizationId: toOrganizationId(organizationId),
          actor: {type: "system", displayName: "Workflow test"},
          previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          status: WorkflowStatus.APPROVED,
          workflowTemplateActions: initialActions,
          occurredAt: new Date()
        }
        await appendStatusEvent(transactionManager, outbox, event)
        const job = {data: event}

        // When: Processing the event
        await processor.handleWorkflowStatusChanged(job)

        // Expect: Tasks created using the snapshot actions, not the updated template actions
        const emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(1)
        const context = {organizationId: toOrganizationId(organizationId)}
        const email = unwrapRight(await taskService.getEmailTask(context, emailTasks[0]!.id)())
        expect(email.recipients).toEqual(["initial@example.com"])

        const webhookTasks = await prisma.workflowActionsWebhookTask.findMany({where: {workflowId}})
        expect(webhookTasks).toHaveLength(1)
        const webhook = unwrapRight(await taskService.getWebhookTask(context, webhookTasks[0]!.id)())
        expect(webhook.url).toBe("https://initial.example.com/webhook")
        expect(webhook.method).toBe("POST")
      })
    })

    describe("bad cases", () => {
      it("should throw an error if workflow does not exist", async () => {
        // Given: A job with a non-existent workflow ID
        const workflow = await createWorkflowWithTemplate(
          prisma,
          {workflowName: `test-workflow-${uuidv7()}`, workflowStatus: WorkflowStatus.APPROVED, actions: []},
          tenantEncryption
        )
        const event = statusChangedEvent(
          uuidv7(),
          workflow.organizationId,
          WorkflowStatus.EVALUATION_IN_PROGRESS,
          WorkflowStatus.APPROVED,
          []
        )
        await appendStatusEvent(transactionManager, outbox, event)
        const job = {data: event}

        // When
        const result = processor.handleWorkflowStatusChanged(job)

        // Expect
        await expect(result).rejects.toThrow("Failed to process workflow status change")
        expect(await prisma.durableWork.count({where: {organizationId: event.organizationId}})).toBe(0)
        expect(await prisma.tenantEventReceipt.count({where: {eventId: event.eventId}})).toBe(0)
      })
    })
  })

  it("creates encrypted tenant-bound tasks with the event action indexes", async () => {
    // Given: A workflow with initial actions
    const actions = [
      createEmailAction(["first@example.com"]),
      createWebhookAction("https://first.example.com/webhook"),
      createEmailAction(["second@example.com", "team@example.com"]),
      createWebhookAction("https://second.example.com/webhook", WebhookActionHttpMethod.PUT, {
        "X-Custom-Header": "value1"
      })
    ] as const
    const workflow = await createWorkflowWithTemplate(
      prisma,
      {workflowName: `test-workflow-${uuidv7()}`, workflowStatus: WorkflowStatus.APPROVED, actions},
      tenantEncryption
    )
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
    // When: Processing the event
    await processor.handleWorkflowStatusChanged(job(event))

    // Expect: Tasks use the snapshot actions, not the updated template actions
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
    expect(emailRows[0]!.encPayload).not.toContain("first@example.com")
    expect(webhookRows[0]!.encPayload).toBeTruthy()
    expect(webhookRows[0]!.encPayload).not.toContain("https://first.example.com/webhook")

    const emailTask = unwrapRight(
      await taskService.getEmailTask({organizationId: toOrganizationId(workflow.organizationId)}, emailRows[0]!.id)()
    )
    const webhookTask = unwrapRight(
      await taskService.getWebhookTask(
        {organizationId: toOrganizationId(workflow.organizationId)},
        webhookRows[0]!.id
      )()
    )
    const secondEmailTask = unwrapRight(
      await taskService.getEmailTask({organizationId: toOrganizationId(workflow.organizationId)}, emailRows[1]!.id)()
    )
    const secondWebhookTask = unwrapRight(
      await taskService.getWebhookTask(
        {organizationId: toOrganizationId(workflow.organizationId)},
        webhookRows[1]!.id
      )()
    )
    expect(emailTask.recipients).toEqual(["first@example.com"])
    expect(secondEmailTask.recipients).toEqual(["second@example.com", "team@example.com"])
    expect(webhookTask).toMatchObject({url: "https://first.example.com/webhook", method: WebhookActionHttpMethod.POST})
    expect(secondWebhookTask).toMatchObject({
      url: "https://second.example.com/webhook",
      method: WebhookActionHttpMethod.PUT,
      headers: {"X-Custom-Header": "value1"}
    })
  })

  it("publishes task-ready events only after the task, receipt and outbox commit", async () => {
    // Given
    const actions = [createEmailAction(["committed@example.com"])] as const
    const workflow = await createWorkflowWithTemplate(
      prisma,
      {workflowName: `test-workflow-${uuidv7()}`, workflowStatus: WorkflowStatus.APPROVED, actions},
      tenantEncryption
    )
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

    // When
    await processor.handleWorkflowStatusChanged(job(event))

    // Expect
    expect(enqueue).toHaveBeenCalledTimes(1)
    const readyRow = await prisma.tenantOutbox.findFirstOrThrow({
      where: {
        organizationId: event.organizationId,
        eventType: "task.ready"
      }
    })
    expect(readyRow.publishedAt).toBeInstanceOf(Date)
    // When
    await processor.handleWorkflowStatusChanged(job(event))
    // Expect
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it("keeps committed tasks and unpublished outbox facts when best-effort enqueue fails", async () => {
    // Given
    const actions = [createEmailAction(["recover@example.com"])] as const
    const workflow = await createWorkflowWithTemplate(
      prisma,
      {workflowName: `test-workflow-${uuidv7()}`, workflowStatus: WorkflowStatus.APPROVED, actions},
      tenantEncryption
    )
    const event = statusChangedEvent(
      workflow.workflowId,
      workflow.organizationId,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      WorkflowStatus.APPROVED,
      actions
    )
    await appendStatusEvent(transactionManager, outbox, event)
    const enqueue = jest.spyOn(queue, "enqueue").mockReturnValue(TE.left("unknown_error"))
    const logError = jest.spyOn(Logger, "error").mockImplementation(() => {})

    // When
    const result = processor.handleWorkflowStatusChanged(job(event))

    // Expect
    await expect(result).resolves.toBeUndefined()
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
    expect(logError).toHaveBeenCalledWith(
      `Failed to publish task-ready event ${readyRow.eventId} for task ${readyRow.resourceId} in organization ${event.organizationId}; the outbox will retry.`,
      "unknown_error"
    )
  })

  it("keeps an empty event snapshot authoritative when the template has actions", async () => {
    // Given
    const workflow = await createWorkflowWithTemplate(
      prisma,
      {
        workflowName: `test-workflow-${uuidv7()}`,
        workflowStatus: WorkflowStatus.APPROVED,
        actions: [createEmailAction(["unused@example.com"])]
      },
      tenantEncryption
    )
    const event = statusChangedEvent(
      workflow.workflowId,
      workflow.organizationId,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      WorkflowStatus.APPROVED,
      []
    )
    await appendStatusEvent(transactionManager, outbox, event)
    // When
    await processor.handleWorkflowStatusChanged(job(event))
    await processor.handleWorkflowStatusChanged(job(event))
    // Expect
    expect(await prisma.workflowActionsEmailTask.count({where: {workflowId: workflow.workflowId}})).toBe(0)
    expect(await prisma.durableWork.count({where: {organizationId: event.organizationId}})).toBe(0)
    expect(await prisma.tenantEventReceipt.count({where: {eventId: event.eventId, consumer: "task_generation"}})).toBe(
      1
    )
  })

  it.each([undefined, null, {}])("rejects a missing or malformed actions snapshot (%p)", async actions => {
    // Given
    const workflow = await createWorkflowWithTemplate(
      prisma,
      {
        workflowName: `test-workflow-${uuidv7()}`,
        workflowStatus: WorkflowStatus.APPROVED,
        actions: [createEmailAction(["unused@example.com"])]
      },
      tenantEncryption
    )
    const event = statusChangedEvent(
      workflow.workflowId,
      workflow.organizationId,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      WorkflowStatus.APPROVED
    )
    // When
    const result = processor.handleWorkflowStatusChanged({
      data: {...event, workflowTemplateActions: actions}
    })
    // Expect
    await expect(result).rejects.toThrow("tenant_event_workflow_actions_invalid")
    expect(await prisma.durableWork.count({where: {organizationId: event.organizationId}})).toBe(0)
    expect(await prisma.tenantEventReceipt.count({where: {eventId: event.eventId}})).toBe(0)
  })

  it("does not create duplicate tasks when the same event is processed concurrently", async () => {
    // Given
    const actions = [createEmailAction(["idempotent@example.com"])] as const
    const workflow = await createWorkflowWithTemplate(
      prisma,
      {workflowName: `test-workflow-${uuidv7()}`, workflowStatus: WorkflowStatus.APPROVED, actions},
      tenantEncryption
    )
    const event = statusChangedEvent(
      workflow.workflowId,
      workflow.organizationId,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      WorkflowStatus.APPROVED,
      actions
    )
    const eventJob = job(event)

    await appendStatusEvent(transactionManager, outbox, event)
    // When
    await Promise.all([
      processor.handleWorkflowStatusChanged(eventJob),
      processor.handleWorkflowStatusChanged(eventJob)
    ])

    // Expect
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

  it("rejects an uncommitted status event without persisting tasks or a receipt", async () => {
    // Given
    const actions = [createEmailAction(["uncommitted@example.com"])] as const
    const workflow = await createWorkflowWithTemplate(
      prisma,
      {workflowName: `test-workflow-${uuidv7()}`, workflowStatus: WorkflowStatus.APPROVED, actions},
      tenantEncryption
    )
    const event = statusChangedEvent(
      workflow.workflowId,
      workflow.organizationId,
      WorkflowStatus.EVALUATION_IN_PROGRESS,
      WorkflowStatus.APPROVED,
      actions
    )

    // When
    const processing = processor.handleWorkflowStatusChanged(job(event))

    // Expect
    await expect(processing).rejects.toThrow("event_not_found")
    expect(await prisma.workflowActionsEmailTask.count({where: {workflowId: workflow.workflowId}})).toBe(0)
    expect(await prisma.tenantEventReceipt.count({where: {eventId: event.eventId}})).toBe(0)
    expect(
      await prisma.tenantOutbox.count({where: {organizationId: workflow.organizationId, eventType: "task.ready"}})
    ).toBe(0)
  })

  it("rejects a status event without valid status-event attribution", async () => {
    // Given
    const invalidEvent = {
      schemaVersion: 1,
      type: "workflow.status_changed",
      workflowOcc: 0n,
      eventId: uuidv7(),
      workflowId: uuidv7(),
      organizationId: randomOrgId(),
      previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
      status: WorkflowStatus.APPROVED,
      workflowTemplateActions: [],
      occurredAt: new Date().toISOString()
    }
    // When
    const result = processor.handleWorkflowStatusChanged({data: invalidEvent})
    // Expect
    await expect(result).rejects.toThrow("tenant_event_actor_malformed_object")
  })
})

async function appendStatusEvent(
  transactionManager: TenantTransactionManager,
  outbox: TenantOutboxRepository,
  event: WorkflowStatusChangedEvent
): Promise<void> {
  unwrapRight(await appendTenantEvent(transactionManager, outbox, event)())
}
