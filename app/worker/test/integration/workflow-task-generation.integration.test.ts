import {WorkflowEventsProcessor} from "../../src/processor/workflow-events.processor"
import {TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider, createMockWorkflowTemplateInDb, createMockSpaceInDb} from "@test/mock-data"
import {cleanDatabase, prepareDatabase, prepareRedisPrefix, cleanRedisByPrefix} from "@test/database"
import {DatabaseClient} from "@external"
import {PrismaClient, Prisma} from "@prisma/client"
import {Job} from "bull"
import {WorkflowStatusChangedEvent, WorkflowStatus, WorkflowActionType, EmailAction, WebhookAction} from "@domain"
import {randomUUID} from "crypto"
import {WebhookActionHttpMethod} from "@domain/workflow-actions"
import {setupWorkerTestModule} from "./test-helpers"

type WorkflowStatusChangedJobData = WorkflowStatusChangedEvent

async function createWorkflowWithTemplate(
  prisma: PrismaClient,
  config: {
    workflowName: string
    workflowStatus: WorkflowStatus
    actions: ReadonlyArray<EmailAction | WebhookAction>
  }
): Promise<{
  workflowId: string
  templateId: string
  spaceId: string
  actions: ReadonlyArray<EmailAction | WebhookAction>
}> {
  const spaceId = (await createMockSpaceInDb(prisma)).id

  const template = await createMockWorkflowTemplateInDb(prisma, {
    spaceId,
    actions: config.actions as Prisma.InputJsonValue
  })

  const workflow = await prisma.workflow.create({
    data: {
      id: randomUUID(),
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
    spaceId,
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

describe("Workflow Task Generation Integration", () => {
  let processor: WorkflowEventsProcessor
  let prisma: PrismaClient
  let redisPrefix: string
  let module: TestingModule

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    try {
      const moduleBuilder = setupWorkerTestModule([WorkflowEventsProcessor])
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb, redisPrefix))

      module = await moduleBuilder.compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    processor = module.get<WorkflowEventsProcessor>(WorkflowEventsProcessor)
    prisma = module.get(DatabaseClient)

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

  describe("handleWorkflowStatusChanged", () => {
    describe("good cases", () => {
      it("should create EMAIL and WEBHOOK tasks when workflow is approved", async () => {
        // Given: A workflow with EMAIL and WEBHOOK actions
        const {workflowId, actions} = await createWorkflowWithTemplate(prisma, {
          workflowName: "Test-Workflow-With-Actions",
          workflowStatus: WorkflowStatus.APPROVED,
          actions: [
            createEmailAction(["test@example.com"]),
            createWebhookAction("https://example.com/webhook", WebhookActionHttpMethod.POST)
          ]
        })

        const event: WorkflowStatusChangedEvent = {
          eventId: randomUUID(),
          workflowId,
          oldStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          newStatus: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          timestamp: new Date()
        }

        const job = {
          data: event,
          attemptsMade: 0,
          opts: {attempts: 3},
          id: "job-1"
        } as Job<WorkflowStatusChangedJobData>

        // When
        await processor.handleWorkflowStatusChanged(job)

        // Expect: EMAIL task created
        const emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(1)
        expect(emailTasks[0]!.status).toBe("PENDING")
        expect(emailTasks[0]!.recipients).toEqual(["test@example.com"])
        expect(emailTasks[0]!.subject).toBe("Workflow Test-Workflow-With-Actions status update")
        expect(emailTasks[0]!.body).toContain(
          "The workflow Test-Workflow-With-Actions has transitioned from EVALUATION_IN_PROGRESS to APPROVED"
        )

        // And: WEBHOOK task created
        const webhookTasks = await prisma.workflowActionsWebhookTask.findMany({where: {workflowId}})
        expect(webhookTasks).toHaveLength(1)
        expect(webhookTasks[0]!.status).toBe("PENDING")
        expect(webhookTasks[0]!.url).toBe("https://example.com/webhook")
        expect(webhookTasks[0]!.method).toBe("POST")
      })

      it("should create multiple EMAIL tasks when multiple EMAIL actions are defined", async () => {
        // Given: A workflow with multiple EMAIL actions
        const {workflowId, actions} = await createWorkflowWithTemplate(prisma, {
          workflowName: "Test-Multiple-Emails",
          workflowStatus: WorkflowStatus.APPROVED,
          actions: [
            createEmailAction(["admin@example.com"]),
            createEmailAction(["user@example.com", "team@example.com"]),
            createEmailAction(["ops@example.com"])
          ]
        })

        const event: WorkflowStatusChangedEvent = {
          eventId: randomUUID(),
          workflowId,
          oldStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          newStatus: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          timestamp: new Date()
        }

        const job = {
          data: event,
          attemptsMade: 0,
          opts: {attempts: 3},
          id: "job-2"
        } as Job<WorkflowStatusChangedJobData>

        // When
        await processor.handleWorkflowStatusChanged(job)

        // Expect: 3 EMAIL tasks created
        const emailTasks = await prisma.workflowActionsEmailTask.findMany({
          where: {workflowId}
        })
        expect(emailTasks).toHaveLength(3)

        const allRecipients = emailTasks.map(task => task.recipients)

        // Verify all expected recipient groups are present (order doesn't matter)
        expect(allRecipients).toContainEqual(["admin@example.com"])
        expect(allRecipients).toContainEqual(["user@example.com", "team@example.com"])
        expect(allRecipients).toContainEqual(["ops@example.com"])

        // check subject and body for one task
        const firstTask = emailTasks[0]!
        expect(firstTask.subject).toBe("Workflow Test-Multiple-Emails status update")
        expect(firstTask.body).toContain(
          "The workflow Test-Multiple-Emails has transitioned from EVALUATION_IN_PROGRESS to APPROVED"
        )
      })

      it("should create multiple WEBHOOK tasks with different configurations", async () => {
        // Given: A workflow with multiple WEBHOOK actions
        const {workflowId, actions} = await createWorkflowWithTemplate(prisma, {
          workflowName: "Test-Multiple-Webhooks",
          workflowStatus: WorkflowStatus.APPROVED,
          actions: [
            createWebhookAction("https://api1.example.com/hook", WebhookActionHttpMethod.POST),
            createWebhookAction("https://api2.example.com/hook", WebhookActionHttpMethod.PUT, {
              "X-Custom-Header": "value1"
            }),
            createWebhookAction("https://api3.example.com/hook", WebhookActionHttpMethod.GET)
          ]
        })

        const event: WorkflowStatusChangedEvent = {
          eventId: randomUUID(),
          workflowId,
          oldStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          newStatus: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          timestamp: new Date()
        }

        const job = {
          data: event,
          attemptsMade: 0,
          opts: {attempts: 3},
          id: "job-3"
        } as Job<WorkflowStatusChangedJobData>

        // When
        await processor.handleWorkflowStatusChanged(job)

        // Expect: 3 WEBHOOK tasks created
        const webhookTasks = await prisma.workflowActionsWebhookTask.findMany({
          where: {workflowId},
          orderBy: {url: "asc"}
        })
        expect(webhookTasks).toHaveLength(3)

        expect(webhookTasks[0]!.url).toBe("https://api1.example.com/hook")
        expect(webhookTasks[0]!.method).toBe("POST")
        expect(webhookTasks[0]!.headers).toBeNull()

        expect(webhookTasks[1]!.url).toBe("https://api2.example.com/hook")
        expect(webhookTasks[1]!.method).toBe("PUT")
        const headers1 = webhookTasks[1]!.headers as Record<string, string>
        expect(headers1["X-Custom-Header"]).toBe("value1")

        expect(webhookTasks[2]!.url).toBe("https://api3.example.com/hook")
        expect(webhookTasks[2]!.method).toBe("GET")
      })

      it("should be idempotent (processing the same event twice should not create duplicate tasks)", async () => {
        // Given: A workflow definition
        const {workflowId, actions} = await createWorkflowWithTemplate(prisma, {
          workflowName: "Test-Idempotency",
          workflowStatus: WorkflowStatus.APPROVED,
          actions: [createEmailAction(["idempotency@example.com"])]
        })

        const event: WorkflowStatusChangedEvent = {
          eventId: randomUUID(),
          workflowId,
          oldStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          newStatus: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          timestamp: new Date()
        }

        const job = {
          data: event,
          attemptsMade: 0,
          opts: {attempts: 3},
          id: "job-idempotency"
        } as Job<WorkflowStatusChangedJobData>

        // When: Processed once
        await processor.handleWorkflowStatusChanged(job)

        // Then: Task created
        let emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(1)
        const firstTaskId = emailTasks[0]!.id

        // When: Processed a second time
        await processor.handleWorkflowStatusChanged(job)

        // Then: Still only one task, same ID
        emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(1)
        expect(emailTasks[0]!.id).toBe(firstTaskId)
      })

      it("should recover from partial failure (create missing tasks)", async () => {
        // Given: A workflow with 2 actions
        const {workflowId, actions} = await createWorkflowWithTemplate(prisma, {
          workflowName: "Test-Partial-Recovery",
          workflowStatus: WorkflowStatus.APPROVED,
          actions: [createEmailAction(["recovery@example.com"]), createWebhookAction("https://recovery.example.com")]
        })

        const event: WorkflowStatusChangedEvent = {
          eventId: randomUUID(),
          workflowId,
          oldStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          newStatus: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          timestamp: new Date()
        }

        // And: One task already exists (simulating partial success)
        // We need to generate the deterministic ID to simulate the exact task that would be created
        // Since we can't easily import uuidv5 and the namespace in the test without exporting them or duplicating constants,
        // we will let the processor run once to generate valid IDs, then delete one, then run again.

        // Step 1: Run normal
        const job = {
          data: event,
          attemptsMade: 0,
          opts: {attempts: 3},
          id: "job-recovery"
        } as Job<WorkflowStatusChangedJobData>

        await processor.handleWorkflowStatusChanged(job)

        // Verify both exist
        expect(await prisma.workflowActionsEmailTask.count({where: {workflowId}})).toBe(1)
        expect(await prisma.workflowActionsWebhookTask.count({where: {workflowId}})).toBe(1)

        // Step 2: Delete one task (simulating it didn't exist or was lost)
        await prisma.workflowActionsWebhookTask.deleteMany({where: {workflowId}})
        expect(await prisma.workflowActionsWebhookTask.count({where: {workflowId}})).toBe(0)

        // Step 3: Run again
        await processor.handleWorkflowStatusChanged(job)

        // Expect: Both exist again
        expect(await prisma.workflowActionsEmailTask.count({where: {workflowId}})).toBe(1)
        expect(await prisma.workflowActionsWebhookTask.count({where: {workflowId}})).toBe(1)
      })

      it("should create tasks when workflow is rejected", async () => {
        // Given: A workflow transitioning to REJECTED status
        const {workflowId, actions} = await createWorkflowWithTemplate(prisma, {
          workflowName: "Test-Rejected-Workflow",
          workflowStatus: WorkflowStatus.REJECTED,
          actions: [createEmailAction(["rejection@example.com"])]
        })

        const event: WorkflowStatusChangedEvent = {
          eventId: randomUUID(),
          workflowId,
          oldStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          newStatus: WorkflowStatus.REJECTED,
          workflowTemplateActions: actions,
          timestamp: new Date()
        }

        const job = {
          data: event,
          attemptsMade: 0,
          opts: {attempts: 3},
          id: "job-4"
        } as Job<WorkflowStatusChangedJobData>

        // When
        await processor.handleWorkflowStatusChanged(job)

        // Expect: EMAIL task created
        const emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(1)
      })

      it("should not create tasks when workflow status is EVALUATION_IN_PROGRESS", async () => {
        // Given: A workflow in EVALUATION_IN_PROGRESS status
        const {workflowId, actions} = await createWorkflowWithTemplate(prisma, {
          workflowName: "Test-In-Progress",
          workflowStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          actions: [createEmailAction(["test@example.com"])]
        })

        const event: WorkflowStatusChangedEvent = {
          eventId: randomUUID(),
          workflowId,
          oldStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          newStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          workflowTemplateActions: actions,
          timestamp: new Date()
        }

        const job = {
          data: event,
          attemptsMade: 0,
          opts: {attempts: 3},
          id: "job-5"
        } as Job<WorkflowStatusChangedJobData>

        // When
        await processor.handleWorkflowStatusChanged(job)

        // Expect: No tasks created
        const emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        const webhookTasks = await prisma.workflowActionsWebhookTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(0)
        expect(webhookTasks).toHaveLength(0)
      })

      it("should not create tasks when template has no actions", async () => {
        // Given: A workflow with a template that has no actions
        const {workflowId, actions} = await createWorkflowWithTemplate(prisma, {
          workflowName: "Test-No-Actions",
          workflowStatus: WorkflowStatus.APPROVED,
          actions: []
        })

        const event: WorkflowStatusChangedEvent = {
          eventId: randomUUID(),
          workflowId,
          oldStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          newStatus: WorkflowStatus.APPROVED,
          workflowTemplateActions: actions,
          timestamp: new Date()
        }

        const job = {
          data: event,
          attemptsMade: 0,
          opts: {attempts: 3},
          id: "job-6"
        } as Job<WorkflowStatusChangedJobData>

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
        const {workflowId, templateId} = await createWorkflowWithTemplate(prisma, {
          workflowName: "Test-Snapshot-Actions",
          workflowStatus: WorkflowStatus.APPROVED,
          actions: initialActions
        })

        // And: The template has been updated with different actions in the DB
        const updatedActions = [
          createEmailAction(["updated@example.com", "another@example.com"]),
          createWebhookAction("https://updated.example.com/webhook", WebhookActionHttpMethod.PUT)
        ]
        await prisma.workflowTemplate.update({
          where: {id: templateId},
          data: {
            actions: updatedActions as Prisma.InputJsonValue
          }
        })

        // And: An event with the snapshot of the initial actions
        const event: WorkflowStatusChangedEvent = {
          eventId: randomUUID(),
          workflowId,
          oldStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
          newStatus: WorkflowStatus.APPROVED,
          workflowTemplateActions: initialActions,
          timestamp: new Date()
        }

        const job = {
          data: event,
          attemptsMade: 0,
          opts: {attempts: 3},
          id: "job-snapshot"
        } as Job<WorkflowStatusChangedJobData>

        // When: Processing the event
        await processor.handleWorkflowStatusChanged(job)

        // Expect: Tasks created using the snapshot actions (initial), not the updated template actions
        const emailTasks = await prisma.workflowActionsEmailTask.findMany({where: {workflowId}})
        expect(emailTasks).toHaveLength(1)
        expect(emailTasks[0]!.recipients).toEqual(["initial@example.com"])

        const webhookTasks = await prisma.workflowActionsWebhookTask.findMany({where: {workflowId}})
        expect(webhookTasks).toHaveLength(1)
        expect(webhookTasks[0]!.url).toBe("https://initial.example.com/webhook")
        expect(webhookTasks[0]!.method).toBe("POST")
      })
    })

    describe("bad cases", () => {
      it("should throw an error if workflow does not exist", async () => {
        // Given: A job with a non-existent workflow ID
        const job = {
          data: {
            eventId: randomUUID(),
            workflowId: randomUUID(),
            oldStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
            newStatus: WorkflowStatus.APPROVED,
            workflowTemplateActions: [],
            timestamp: new Date()
          },
          attemptsMade: 0,
          opts: {attempts: 3},
          id: "job-error-1"
        } as unknown as Job<WorkflowStatusChangedJobData>

        // When/Expect: The processor should throw an error
        await expect(processor.handleWorkflowStatusChanged(job)).rejects.toThrow(
          "Failed to process workflow status change"
        )
      })
    })
  })
})
