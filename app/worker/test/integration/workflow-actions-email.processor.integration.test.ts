import {DISPATCH_REPOSITORY_TOKEN, DispatchClaimResult, DispatchRepository} from "@services/durable-work/interfaces"
import {wrapTaskEitherWithSideEffect} from "@test/injectors"
import {toOrganizationId} from "@test/organization-id"
import {WorkflowActionEmailProcessor} from "../../src/processor/workflow-action-email.processor"
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
import {InertQueueProvider, setupWorkerTestModule} from "./test-helpers"
import {WorkflowActionEmailTaskFactory, TaskReadyEvent, WorkflowStatus} from "@domain"

import {MailpitClient} from "mailpit-api"
import {isNone} from "fp-ts/Option"
import {EmailService} from "@services/email/email.service"
import {TaskService} from "@services"
import {QUEUE_PROVIDER_TOKEN} from "@services/queue/interface"
import * as TE from "fp-ts/TaskEither"
import "@utils/matchers"
import {unwrapRight} from "@utils/either"
import {v5 as uuidv5, v7 as uuidv7} from "uuid"

const TASK_ID_NAMESPACE = "95650ca4-d361-11f0-8d0d-325096b39f47"

async function createWorkflowWithEmailTask(
  prisma: PrismaClient,
  recipients: string[] = ["test@localhost.com"],
  subject: string = "Test Email Subject",
  body: string = "<h1>Test Email Body</h1>"
) {
  // Create a space and template first
  const space = await createMockSpaceInDb(prisma)
  const template = await createMockWorkflowTemplateInDb(prisma, {
    organizationId: space.organizationId,
    spaceId: space.id
  })

  // Create a workflow
  const workflow = await prisma.workflow.create({
    data: {
      id: uuidv7(),
      organizationId: template.organizationId,
      name: "Test-Email-Workflow",
      status: WorkflowStatus.EVALUATION_IN_PROGRESS,
      workflowTemplateId: template.id,
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      updatedAt: new Date(),
      occ: 0n,
      recalculationRequired: false
    }
  })

  // Create an email task through the tenant-aware service so payload encryption and durable metadata
  // match production task creation.
  const emailTask = unwrapRight(
    WorkflowActionEmailTaskFactory.newWorkflowActionEmailTask({
      id: uuidv5(`email-task-${workflow.id}`, TASK_ID_NAMESPACE),
      organizationId: toOrganizationId(template.organizationId),
      workflowId: workflow.id,
      recipients,
      subject,
      body
    })
  )

  return {workflowId: workflow.id, organizationId: toOrganizationId(template.organizationId), task: emailTask}
}

describe("Workflow Action Email Processor Integration", () => {
  let processor: WorkflowActionEmailProcessor
  let emailService: EmailService
  let taskService: TaskService
  let prisma: PrismaClient
  let redisPrefix: string
  let module: TestingModule
  let mailpitEndpoint: string
  let senderEmail: string

  beforeAll(async () => {
    const originalEmailConfig = ConfigProvider.validateEmailProviderConfig()

    if (isNone(originalEmailConfig)) throw new Error("Email provider configuration is not valid.")

    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    const mailtpitEnvVariable = process.env.MAILPIT_API_ENDPOINT

    if (!mailtpitEnvVariable)
      throw new Error("MAILPIT_API_ENDPOINT environment variable is not set. This test requires Mailpit to be running.")

    mailpitEndpoint = mailtpitEnvVariable

    senderEmail = `test-sender-${uuidv7()}@localhost.com`

    try {
      const moduleBuilder = setupWorkerTestModule([WorkflowActionEmailProcessor])
        .overrideProvider(ConfigProvider)
        .useValue(
          MockConfigProvider.fromOriginalProvider({
            tenantConnectionUrl: isolatedDb,
            redisPrefix,
            emailProviderConfig: {
              ...originalEmailConfig.value,
              senderEmail
            }
          })
        )
        .overrideProvider(QUEUE_PROVIDER_TOKEN)
        .useClass(InertQueueProvider)

      module = await moduleBuilder.compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    processor = module.get<WorkflowActionEmailProcessor>(WorkflowActionEmailProcessor)
    emailService = module.get<EmailService>(EmailService)
    taskService = module.get<TaskService>(TaskService)
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

  it.each(["suspended", "deleting"] as const)(
    "should pause email work without attempting delivery when the organization is %s",
    async status => {
      // Given
      const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
      unwrapRight(
        await taskService.createEmailTask(
          {organizationId},
          {
            task,
            metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
          }
        )()
      )
      // The task was queued while the organization was active; its status changes before processing.
      await prisma.organization.update({where: {id: organizationId}, data: {status, occ: {increment: 1}}})
      const send = jest.spyOn(emailService, "sendEmail")
      const ready = await prisma.tenantOutbox.findFirstOrThrow({
        where: {organizationId, eventType: "task.ready", resourceId: task.id}
      })
      const event: TaskReadyEvent = {
        schemaVersion: 1,
        eventId: ready.eventId,
        organizationId,
        taskId: task.id,
        taskOcc: task.occ,
        taskKind: "email",
        type: "task.ready"
      }
      // When
      await expect(processor.handleEmailAction({data: event})).resolves.toBeUndefined()
      // Redelivery must also leave the task paused without starting a dispatch attempt.
      await expect(processor.handleEmailAction({data: event})).resolves.toBeUndefined()
      // Expect
      expect(send).not.toHaveBeenCalled()
      const work = await prisma.durableWork.findUniqueOrThrow({
        where: {organizationId_id: {organizationId, id: task.id}}
      })
      // Persist the pause so the queued task is retained, without sending email or consuming an attempt.
      expect(work.state).toBe("paused")
      expect(work.attempts).toBe(0)
      expect(await prisma.dispatchAttempt.count({where: {organizationId}})).toBe(0)
    }
  )

  it("rolls back the work transition when the dispatch attempt changes concurrently", async () => {
    // Given
    // Claim a task and mark its attempt as sending, ready for completion.
    const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
    const context = {organizationId}
    unwrapRight(
      await taskService.createEmailTask(context, {
        task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
      })()
    )
    const claim = requireAdmitted(
      unwrapRight(await taskService.claimDispatch(context, task.id, "email", uuidv7(), new Date())())
    )
    unwrapRight(await taskService.markDispatchSending(context, claim.attemptId, claim.lease)())
    const workBefore = await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})
    const attemptBefore = await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})

    const repository = module.get<DispatchRepository>(DISPATCH_REPOSITORY_TOKEN)
    // After completion reads the attempt, simulate another writer changing its OCC value.
    // The work update can succeed, but the subsequent attempt update must reject the stale snapshot.
    wrapTaskEitherWithSideEffect(repository, "getAttempt", async () => {
      await prisma.dispatchAttempt.update({
        where: {id: claim.attemptId},
        data: {occ: {increment: 1}}
      })
    })

    // When
    const result = await taskService.completeDispatch(context, claim.attemptId, claim.lease, {
      state: "succeeded",
      outcome: {type: "delivered"}
    })()

    // Expect
    expect(result).toBeLeftOf("invalid_transition")
    // Roll back the work update and preserve only the competing writer's OCC increment.
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).toEqual(workBefore)
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})).toEqual({
      ...attemptBefore,
      occ: attemptBefore.occ + 1n
    })
  })

  it.each([99, 600, 200.5, NaN])("rejects invalid HTTP status %s without completing the dispatch", async statusCode => {
    // Given
    const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
    const context = {organizationId}
    unwrapRight(
      await taskService.createEmailTask(context, {
        task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
      })()
    )
    const claim = requireAdmitted(
      unwrapRight(await taskService.claimDispatch(context, task.id, "email", uuidv7(), new Date())())
    )
    unwrapRight(await taskService.markDispatchSending(context, claim.attemptId, claim.lease)())
    const before = await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})

    // When
    const result = await taskService.completeDispatch(context, claim.attemptId, claim.lease, {
      state: "succeeded",
      outcome: {type: "http_response", statusCode}
    })()

    // Expect
    expect(result).toBeLeftOf("dispatch_invalid_http_status")
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})).toEqual(before)
    expect((await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).state).toBe("sending")
  })

  it("fences an old dispatch through TaskService after another worker claims the retry", async () => {
    // Given: The first worker fails before delivery, and a second worker claims the retry.
    const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
    const context = {organizationId}
    unwrapRight(
      await taskService.createEmailTask(context, {
        task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
      })()
    )
    const first = requireAdmitted(
      unwrapRight(await taskService.claimDispatch(context, task.id, "email", uuidv7(), new Date())())
    )
    // The first worker fails before sending, making retry safe for email.
    unwrapRight(
      await taskService.completeDispatch(context, first.attemptId, first.lease, {
        state: "failed",
        outcome: {type: "task_load_failed", error: "task_not_found"}
      })()
    )
    const nextOwner = uuidv7()
    const second = requireAdmitted(
      unwrapRight(await taskService.claimDispatch(context, task.id, "email", nextOwner, new Date())())
    )
    const before = await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})

    // When: The old worker tries to start delivery and report completion using its stale lease.
    const staleSending = await taskService.markDispatchSending(context, first.attemptId, first.lease)()
    const staleCompletion = await taskService.completeDispatch(context, first.attemptId, first.lease, {
      state: "succeeded",
      outcome: {type: "delivered"}
    })()

    // Expect: Both operations are rejected and the second worker's work remains unchanged.
    expect(second.lease.fencing).toBeGreaterThan(first.lease.fencing)
    expect(staleSending).toBeLeftOf("lease_lost")
    expect(staleCompletion).toBeLeftOf("lease_lost")
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).toEqual(before)
    expect(before.leaseOwner).toBe(nextOwner)

    // When: The current owner starts delivery and reports success using its valid lease.
    unwrapRight(await taskService.markDispatchSending(context, second.attemptId, second.lease)())
    unwrapRight(
      await taskService.completeDispatch(context, second.attemptId, second.lease, {
        state: "succeeded",
        outcome: {type: "delivered"}
      })()
    )
    // Expect: Rejecting the stale worker has not prevented the current owner from completing the task.
    expect((await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).state).toBe("succeeded")
  })

  it("rejects dispatch completion after its lease expires without changing work or attempt state", async () => {
    // Given: A worker has started sending, but its stored lease expires before completion.
    const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
    const context = {organizationId}
    unwrapRight(
      await taskService.createEmailTask(context, {
        task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
      })()
    )
    const claimed = requireAdmitted(
      unwrapRight(await taskService.claimDispatch(context, task.id, "email", uuidv7(), new Date())())
    )
    unwrapRight(await taskService.markDispatchSending(context, claimed.attemptId, claimed.lease)())
    // Expire the stored lease deterministically; no timing-dependent sleep or second email send.
    await prisma.durableWork.update({where: {id: task.id}, data: {leaseUntil: new Date(0)}})
    const before = await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})
    const attemptBefore = await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claimed.attemptId}})

    // When: The worker reports success using the expired lease.
    const result = await taskService.completeDispatch(context, claimed.attemptId, claimed.lease, {
      state: "succeeded",
      outcome: {type: "delivered"}
    })()

    // Expect: Completion is rejected and neither the work nor its attempt is changed.
    expect(result).toBeLeftOf("lease_lost")
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).toEqual(before)
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claimed.attemptId}})).toEqual(attemptBefore)
  })

  describe("process", () => {
    it("should successfully process an email task and update task status to COMPLETED", async () => {
      // Given: An email task in PENDING status
      const recipient = `recipient-${uuidv7()}@localhost.com`
      const {task, organizationId} = await createWorkflowWithEmailTask(prisma, [recipient])
      const eventId = uuidv7()
      await taskService.createEmailTask(
        {organizationId},
        {
          task,
          metadata: {
            eventId,
            actionIndex: 0,
            availableAt: task.createdAt
          }
        }
      )()

      // Create the event to process
      const event: TaskReadyEvent = {
        schemaVersion: 1,
        eventId,
        taskOcc: task.occ,
        organizationId: toOrganizationId(organizationId),
        taskId: task.id,
        taskKind: "email",
        type: "task.ready"
      }

      const job = {
        data: event,
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "test-job-email-1"
      }

      // When: Process the email task
      await processor.handleEmailAction(job)

      // Expect: The email was sent (captured by Mailpit)
      // Note: We search by recipient to avoid interference with other tests
      const mailpit = new MailpitClient(`http://${mailpitEndpoint}`)
      const response = await mailpit.searchMessages({query: `to:"${recipient}"`})
      const messages = response.messages || []
      expect(messages).toHaveLength(1)
      expect(messages[0]?.To?.[0]?.Address).toBe(recipient)
      expect(messages[0]?.From?.Address).toBe(senderEmail)

      // And: The task was updated to COMPLETED status
      const updatedTask = await prisma.durableWork.findUnique({
        where: {organizationId_id: {organizationId, id: task.id}}
      })

      expect(updatedTask).toBeDefined()
      expect(updatedTask?.state).toBe("succeeded")
      expect(
        await prisma.dispatchAttempt.findFirstOrThrow({where: {organizationId, durableWorkId: task.id}})
      ).toMatchObject({state: "succeeded", outcomeCategory: "delivered"})
      expect(updatedTask?.attempts).toBe(1)
      expect(updatedTask?.organizationId).toBe(organizationId)
    })

    it("should acknowledge an email delivery error after persisting an unknown outcome", async () => {
      // Given: An email task in PENDING status
      const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
      const eventId = uuidv7()
      await taskService.createEmailTask(
        {organizationId},
        {
          task,
          metadata: {
            eventId,
            actionIndex: 0,
            availableAt: task.createdAt
          }
        }
      )()

      // Mock the email service to fail
      const emailSpy = jest
        .spyOn(emailService, "sendEmail")
        .mockReturnValueOnce(TE.left("email_unknown_error" as const))

      // Create the event to process
      const event: TaskReadyEvent = {
        schemaVersion: 1,
        eventId,
        taskOcc: task.occ,
        organizationId: toOrganizationId(organizationId),
        taskId: task.id,
        taskKind: "email",
        type: "task.ready"
      }

      const job = {
        data: event,
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "test-job-email-2"
      }

      // When: Process the email task
      // The uncertain delivery outcome is persisted; acknowledge the job without retrying the email.
      await processor.handleEmailAction(job)

      // Expect: The task retains the unknown outcome and its single dispatch attempt.
      const updatedTask = await prisma.durableWork.findUnique({
        where: {organizationId_id: {organizationId, id: task.id}}
      })

      expect(updatedTask).toBeDefined()
      expect(updatedTask?.state).toBe("unknown")
      expect(updatedTask?.attempts).toBe(1)
      expect(updatedTask?.organizationId).toBe(organizationId)

      emailSpy.mockRestore()
    })
  })
})

function requireAdmitted(result: DispatchClaimResult) {
  if (result.state !== "admitted") throw new Error("Expected admitted dispatch")
  return result
}
