import {RedisClient} from "@external/redis/redis-client"
import {serializeTenantEvent} from "@external/queue/tenant-event-payload"
import {
  DISPATCH_REPOSITORY_TOKEN,
  DispatchClaimResult,
  DispatchRepository,
  DELIVERY_CONCURRENCY_LIMITER_TOKEN,
  DeliveryConcurrencyLimiter
} from "@services/durable-work/interfaces"
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
import {InertQueueProvider, persistTaskFixture, setupWorkerTestModule} from "./test-helpers"
import {TASK_ID_NAMESPACE, WorkflowActionEmailTaskFactory, TaskReadyEvent, WorkflowStatus} from "@domain"

import {MailpitClient} from "mailpit-api"
import {isNone} from "fp-ts/Option"
import {EmailService} from "@services/email/email.service"
import {DispatchService} from "@services/durable-work/dispatch.service"
import {TaskService} from "@services"
import {QUEUE_PROVIDER_TOKEN} from "@services/queue/interface"
import * as TE from "fp-ts/TaskEither"
import "@utils/matchers"
import {unwrapRight} from "@utils/either"
import {v5 as uuidv5, v7 as uuidv7} from "uuid"

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
  let dispatch: DispatchService
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
    dispatch = module.get(DispatchService)
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
      const event = await persistTaskFixture(module, {
        kind: "email",
        request: {
          task,
          metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
        }
      })
      // The task was queued while the organization was active; its status changes before processing.
      await prisma.organization.update({where: {id: organizationId}, data: {status, occ: {increment: 1}}})
      const send = jest.spyOn(emailService, "sendEmail")

      const job = {data: serializeTenantEvent(event)}

      // When
      const processing = processor.handleEmailAction(job)

      // Expect
      await expect(processing).resolves.toBeUndefined()

      // When: Redeliver the same job.
      const redelivery = processor.handleEmailAction(job)

      // Expect: Redelivery also leaves the task paused without starting a dispatch attempt.
      await expect(redelivery).resolves.toBeUndefined()
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
    // Claim a task and start its execution, ready for completion.
    const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
    const context = {organizationId}
    const event = await persistTaskFixture(module, {
      kind: "email",
      request: {
        task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
      }
    })
    const claim = requireAdmitted(unwrapRight(await taskService.claimDispatch(context, task.id, "email", uuidv7())()))
    unwrapRight(await taskService.startDispatchExecution(context, claim.attemptId, claim.lease)())
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
    const result = await dispatch.complete(
      context,
      claim.attemptId,
      claim.lease,
      {state: "succeeded", outcome: {type: "delivered"}},
      event.eventId
    )()

    // Expect
    expect(result).toBeLeftOf("dispatch_attempt_concurrent_modification")
    // Roll back the work update and preserve only the competing writer's OCC increment.
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).toEqual(workBefore)
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})).toEqual({
      ...attemptBefore,
      occ: attemptBefore.occ + 1n
    })
  })

  it("rolls back admission when its attempt fence is already occupied", async () => {
    // Given
    const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
    const event = await persistTaskFixture(module, {
      kind: "email",
      request: {
        task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
      }
    })
    const before = await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})
    const existing = await prisma.dispatchAttempt.create({
      data: {
        id: uuidv7(),
        organizationId,
        taskId: task.id,
        fencing: 1n,
        state: "admitted",
        occ: 0n,
        admittedAt: new Date()
      }
    })

    const send = jest.spyOn(emailService, "sendEmail")

    const job = {data: serializeTenantEvent(event)}

    // When
    const processing = processor.handleEmailAction(job)

    // Expect
    await expect(processing).rejects.toThrow("dispatch_inconsistent_state")
    expect(send).not.toHaveBeenCalled()
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).toEqual(before)
    expect(await prisma.dispatchAttempt.findMany({where: {taskId: task.id}})).toEqual([existing])
  })

  it.each([99, 600, 200.5, NaN])("rejects invalid HTTP status %s without completing the dispatch", async statusCode => {
    // Given
    const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
    const context = {organizationId}
    await persistTaskFixture(module, {
      kind: "email",
      request: {
        task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
      }
    })
    const claim = requireAdmitted(unwrapRight(await taskService.claimDispatch(context, task.id, "email", uuidv7())()))
    unwrapRight(await taskService.startDispatchExecution(context, claim.attemptId, claim.lease)())
    const before = await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})

    // When
    const result = await dispatch.complete(
      context,
      claim.attemptId,
      claim.lease,
      {
        state: "succeeded",
        outcome: {type: "http_response", statusCode}
      },
      uuidv7()
    )()

    // Expect
    expect(result).toBeLeftOf("dispatch_invalid_http_status")
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})).toEqual(before)
    expect((await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).state).toBe("executing")
  })

  it("fences an old dispatch through TaskService after another worker claims the retry", async () => {
    // Given: The first worker fails before delivery, and a second worker claims the retry.
    const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
    const context = {organizationId}
    const event = await persistTaskFixture(module, {
      kind: "email",
      request: {
        task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
      }
    })

    const first = requireAdmitted(unwrapRight(await taskService.claimDispatch(context, task.id, "email", uuidv7())()))
    // A database transaction conflict interrupts loading before sending; another worker can retry the read.
    unwrapRight(
      await dispatch.complete(
        context,
        first.attemptId,
        first.lease,
        {
          state: "failed",
          outcome: {type: "task_load_failed", error: {code: "task_load_transaction_conflict", retryable: true}}
        },
        uuidv7()
      )()
    )
    const nextOwner = uuidv7()
    const second = requireAdmitted(unwrapRight(await taskService.claimDispatch(context, task.id, "email", nextOwner)()))
    const before = await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})

    // When: The old worker tries to start delivery and report completion using its stale lease.
    const staleSending = await taskService.startDispatchExecution(context, first.attemptId, first.lease)()
    const staleCompletion = await dispatch.complete(
      context,
      first.attemptId,
      first.lease,
      {
        state: "succeeded",
        outcome: {type: "delivered"}
      },
      uuidv7()
    )()

    // Expect: Both operations are rejected and the second worker's work remains unchanged.
    expect(second.lease.fencing).toBeGreaterThan(first.lease.fencing)
    expect(staleSending).toBeLeftOf("lease_lost")
    expect(staleCompletion).toBeLeftOf("lease_lost")
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).toEqual(before)
    expect(before.leaseOwner).toBe(nextOwner)

    // When: The current owner starts delivery and reports success using its valid lease.
    unwrapRight(await taskService.startDispatchExecution(context, second.attemptId, second.lease)())
    unwrapRight(
      await dispatch.complete(
        context,
        second.attemptId,
        second.lease,
        {
          state: "succeeded",
          outcome: {type: "delivered"}
        },
        event.eventId
      )()
    )
    // Expect: Rejecting the stale worker has not prevented the current owner from completing the task.
    expect((await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).state).toBe("succeeded")
  })

  it("rejects dispatch completion after its lease expires without changing work or attempt state", async () => {
    // Given: A worker has started sending, but its stored lease expires before completion.
    const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
    const context = {organizationId}
    await persistTaskFixture(module, {
      kind: "email",
      request: {
        task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
      }
    })
    const claimed = requireAdmitted(unwrapRight(await taskService.claimDispatch(context, task.id, "email", uuidv7())()))
    unwrapRight(await taskService.startDispatchExecution(context, claimed.attemptId, claimed.lease)())
    // Expire the stored lease deterministically; no timing-dependent sleep or second email send.
    await prisma.durableWork.update({where: {id: task.id}, data: {leaseUntil: new Date(0)}})
    const before = await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})
    const attemptBefore = await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claimed.attemptId}})

    // When: The worker reports success using the expired lease.
    const result = await dispatch.complete(
      context,
      claimed.attemptId,
      claimed.lease,
      {
        state: "succeeded",
        outcome: {type: "delivered"}
      },
      uuidv7()
    )()

    // Expect: Completion is rejected and neither the work nor its attempt is changed.
    expect(result).toBeLeftOf("lease_lost")
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).toEqual(before)
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claimed.attemptId}})).toEqual(attemptBefore)
  })

  it("rejects another task's ciphertext before sending email", async () => {
    // Given: Two tasks have payloads encrypted for their own organization and task IDs.
    const source = await createWorkflowWithEmailTask(prisma)
    const target = await createWorkflowWithEmailTask(prisma)
    await persistTaskFixture(module, {
      kind: "email",
      request: {
        task: source.task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: source.task.createdAt}
      }
    })
    const event = await persistTaskFixture(module, {
      kind: "email",
      request: {
        task: target.task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: target.task.createdAt}
      }
    })
    const ciphertext = await prisma.workflowActionsEmailTask.findUniqueOrThrow({where: {id: source.task.id}})
    // Deliberately substitute valid ciphertext from another task. Decryption must check
    // its authenticated context against the target row, even though the ciphertext is valid.
    await prisma.workflowActionsEmailTask.update({
      where: {id: target.task.id},
      data: {encPayload: ciphertext.encPayload}
    })

    const send = jest.spyOn(emailService, "sendEmail")

    const job = {data: serializeTenantEvent(event)}

    // When: The processor loads the target task using its expected encryption context.
    const processing = processor.handleEmailAction(job)

    // Expect: Reject the substituted payload before delivery and persist a terminal failure.
    await expect(processing).rejects.toThrow("ciphertext_context_mismatch")
    expect(send).not.toHaveBeenCalled()
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: target.task.id}})).toMatchObject({
      state: "failed"
    })
    expect(await prisma.dispatchAttempt.findFirstOrThrow({where: {taskId: target.task.id}})).toMatchObject({
      state: "failed",
      outcomeCategory: "ciphertext_context_mismatch"
    })
    expect(await prisma.tenantEventReceipt.count({where: {eventId: event.eventId}})).toBe(1)
  })

  it("rejects a task event with no committed outbox parent before sending email", async () => {
    // Given: A persisted task with a forged queue envelope referencing a nonexistent event.
    const {task} = await createWorkflowWithEmailTask(prisma)
    const ready = await persistTaskFixture(module, {
      kind: "email",
      request: {
        task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
      }
    })
    const event: TaskReadyEvent = {...ready, eventId: uuidv7()}
    const send = jest.spyOn(emailService, "sendEmail").mockReturnValue(TE.right(undefined))

    const job = {data: serializeTenantEvent(event)}

    // When: Process the uncommitted envelope.
    const processing = processor.handleEmailAction(job)

    // Expect: Reject before admission or delivery, leaving persisted work ready.
    await expect(processing).rejects.toThrow("event_not_found")

    // When: Redeliver the same uncommitted envelope.
    const redelivery = processor.handleEmailAction(job)

    // Expect
    await expect(redelivery).rejects.toThrow("event_not_found")
    expect(send).not.toHaveBeenCalled()
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).toMatchObject({
      state: "ready",
      attempts: 0,
      occ: 0n
    })
    expect(await prisma.dispatchAttempt.count({where: {taskId: task.id}})).toBe(0)
  })

  it("preserves confirmed email delivery when the outbox event disappears before completion", async () => {
    // Given: A valid event passes admission, then its outbox parent is removed during delivery.
    // This crafted integrity failure verifies that receipt failure cannot undo confirmed delivery.
    const {task} = await createWorkflowWithEmailTask(prisma)
    const event = await persistTaskFixture(module, {
      kind: "email",
      request: {
        task,
        metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}
      }
    })
    const send = jest.spyOn(emailService, "sendEmail").mockImplementation(() =>
      TE.fromTask(async () => {
        await prisma.tenantOutbox.delete({
          where: {organizationId_eventId: {organizationId: event.organizationId, eventId: event.eventId}}
        })
      })
    )

    const job = {data: serializeTenantEvent(event)}

    // When: The provider confirms delivery, but receipt insertion has no outbox parent.
    const processing = processor.handleEmailAction(job)

    // Expect: Acknowledge successful processing and commit both terminal states despite the missing receipt.
    await expect(processing).resolves.toBeUndefined()
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).toMatchObject({
      state: "succeeded",
      leaseUntil: null
    })
    expect(await prisma.dispatchAttempt.findFirstOrThrow({where: {taskId: task.id}})).toMatchObject({
      state: "succeeded",
      outcomeCategory: "delivered",
      completedAt: expect.any(Date)
    })
    expect(await prisma.tenantEventReceipt.count({where: {eventId: event.eventId}})).toBe(0)

    // When: The same queue envelope is redelivered after its outbox parent was removed.
    const redelivery = processor.handleEmailAction(job)

    // Expect: Reject the missing event without another send or attempt.
    await expect(redelivery).rejects.toThrow("event_not_found")
    expect(send).toHaveBeenCalledTimes(1)
    expect(await prisma.dispatchAttempt.count({where: {taskId: task.id}})).toBe(1)
  })

  describe("process", () => {
    it("defers email at capacity without claiming work, then delivers after a slot is released", async () => {
      // Given: real Redis permits fill this organization's configured delivery capacity.
      const recipient = `capacity-${uuidv7()}@localhost.com`
      const {task, organizationId} = await createWorkflowWithEmailTask(prisma, [recipient])
      const event = await persistTaskFixture(module, {
        kind: "email",
        request: {task, metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: task.createdAt}}
      })
      const context = {organizationId}
      const limiter = module.get<DeliveryConcurrencyLimiter>(DELIVERY_CONCURRENCY_LIMITER_TOKEN)
      const capacity = module.get(ConfigProvider).dispatchConfig.concurrencyPerOrganization
      const held = await Promise.all(
        Array.from({length: capacity}, async () => {
          const taskId = uuidv7()
          return {taskId, permit: unwrapRight(await limiter.acquirePermit(context, taskId, uuidv7())())}
        })
      )
      // TODO: Type check before accessing.
      const first = held[0]!
      const before = await prisma.durableWork.findUniqueOrThrow({
        where: {organizationId_id: {organizationId, id: task.id}}
      })
      const job = {data: serializeTenantEvent(event)}
      const mailpit = new MailpitClient(`http://${mailpitEndpoint}`)

      // When: the processor receives a valid event while all slots are occupied.
      const blocked = processor.handleEmailAction(job)

      // Expect: Bull can retry; no dispatch claim, persisted change, or email is produced.
      await expect(blocked).rejects.toThrow("capacity_exceeded")
      expect(await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).toEqual(before)
      expect(await prisma.dispatchAttempt.count({where: {organizationId, taskId: task.id}})).toBe(0)
      expect((await mailpit.searchMessages({query: `to:"${recipient}"`})).messages).toHaveLength(0)

      // When: another organization delivers while the first organization remains at capacity.
      const otherRecipient = `other-capacity-${uuidv7()}@localhost.com`
      const other = await createWorkflowWithEmailTask(prisma, [otherRecipient])
      const otherEvent = await persistTaskFixture(module, {
        kind: "email",
        request: {task: other.task, metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: other.task.createdAt}}
      })
      await processor.handleEmailAction({data: serializeTenantEvent(otherEvent)})

      // Expect: organization-scoped capacity permits the independent email and durable completion.
      expect((await mailpit.searchMessages({query: `to:"${otherRecipient}"`})).messages).toHaveLength(1)
      expect(await prisma.durableWork.findUniqueOrThrow({where: {id: other.task.id}})).toMatchObject({
        state: "succeeded"
      })

      // When: one real permit is released and the same event is retried.
      unwrapRight(await limiter.releasePermit(context, first.taskId, first.permit)())
      await processor.handleEmailAction(job)

      // Expect: exactly one email and one successful dispatch are recorded.
      expect((await mailpit.searchMessages({query: `to:"${recipient}"`})).messages).toHaveLength(1)
      expect(await prisma.durableWork.findUniqueOrThrow({where: {id: task.id}})).toMatchObject({
        state: "succeeded",
        attempts: 1
      })
      expect(await prisma.dispatchAttempt.count({where: {organizationId, taskId: task.id}})).toBe(1)
      // The processor releases its permit; only the deliberately held reservations remain.
      expect(await module.get(RedisClient).zcard(`${redisPrefix}dispatch:{${organizationId}}:expiry`)).toBe(
        capacity - 1
      )
      expect(await prisma.dispatchAttempt.findFirstOrThrow({where: {organizationId, taskId: task.id}})).toMatchObject({
        state: "succeeded",
        outcomeCategory: "delivered"
      })
    })

    it("should successfully process an email task and update task status to COMPLETED", async () => {
      // Given: A ready email task with a committed task.ready event and a unique recipient.
      const recipient = `recipient-${uuidv7()}@localhost.com`
      const {task, organizationId} = await createWorkflowWithEmailTask(prisma, [recipient])
      const sourceEventId = uuidv7()
      const event = await persistTaskFixture(module, {
        kind: "email",
        request: {
          task,
          metadata: {
            eventId: sourceEventId,
            actionIndex: 0,
            availableAt: task.createdAt
          }
        }
      })

      const job = {
        data: serializeTenantEvent(event),
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

      // Expect: Successful delivery is persisted with one completed dispatch attempt.
      const updatedTask = await prisma.durableWork.findUnique({
        where: {organizationId_id: {organizationId, id: task.id}}
      })

      expect(updatedTask).toBeDefined()
      expect(updatedTask?.state).toBe("succeeded")
      expect(await prisma.dispatchAttempt.findFirstOrThrow({where: {organizationId, taskId: task.id}})).toMatchObject({
        state: "succeeded",
        outcomeCategory: "delivered"
      })
      expect(updatedTask?.attempts).toBe(1)
      expect(updatedTask?.organizationId).toBe(organizationId)
    })

    it("should acknowledge an email delivery error after persisting an unknown outcome", async () => {
      // Given: A ready task whose email provider cannot confirm whether delivery succeeded.
      const {task, organizationId} = await createWorkflowWithEmailTask(prisma)
      const sourceEventId = uuidv7()
      const event = await persistTaskFixture(module, {
        kind: "email",
        request: {
          task,
          metadata: {
            eventId: sourceEventId,
            actionIndex: 0,
            availableAt: task.createdAt
          }
        }
      })

      // An uncertain provider error must retain an unknown outcome to avoid duplicate email.
      const emailSpy = jest
        .spyOn(emailService, "sendEmail")
        .mockReturnValueOnce(TE.left("email_unknown_error" as const))

      const job = {
        data: serializeTenantEvent(event),
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "test-job-email-2"
      }

      // When: Process the task and receive the uncertain delivery result.
      const processing = processor.handleEmailAction(job)

      // Expect: Acknowledge the job after recording the unknown outcome instead of requesting a retry.
      await expect(processing).resolves.toBeUndefined()
      expect(emailSpy).toHaveBeenCalledTimes(1)
      const updatedTask = await prisma.durableWork.findUnique({
        where: {organizationId_id: {organizationId, id: task.id}}
      })

      expect(updatedTask).toBeDefined()
      expect(updatedTask?.state).toBe("unknown")
      expect(updatedTask?.attempts).toBe(1)
      expect(updatedTask?.organizationId).toBe(organizationId)

      expect(await prisma.dispatchAttempt.findFirstOrThrow({where: {organizationId, taskId: task.id}})).toMatchObject({
        state: "unknown",
        outcomeCategory: "email_unknown_error"
      })

      emailSpy.mockRestore()
    })
  })
})

function requireAdmitted(result: DispatchClaimResult) {
  if (result.state !== "admitted") throw new Error("Expected admitted dispatch")
  return result
}
