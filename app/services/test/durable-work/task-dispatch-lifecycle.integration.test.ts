import {TaskReadyEvent} from "@domain"
import {OidcBootstrapService} from "@external/oidc/oidc-bootstrap.service"
import {
  DispatchClaimResult,
  EVENT_RECEIPT_REPOSITORY_TOKEN,
  EventReceiptRepository,
  DeliveryConcurrencyLimiter,
  DELIVERY_CONCURRENCY_LIMITER_TOKEN
} from "@services/durable-work/interfaces"
import * as E from "fp-ts/Either"
import {isLeft} from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {ConfigProvider} from "@external/config"
import {RedisClient} from "@external/redis/redis-client"
import {ServiceModule} from "@services/service.module"
import {DispatchService} from "@services/durable-work/dispatch.service"
import {TaskService} from "@services/task/task.service"
import {
  createFixturePrismaClient,
  dropPreparedDatabase,
  prepareDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {randomOrgId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

// SQL grants and controlled claim/send/commit interleavings require direct boundary access.
describe("dispatch capability and lifecycle race boundaries", () => {
  let connection: string
  let prisma: PrismaClient
  let module: TestingModule
  let tasks: TaskService
  let dispatch: DispatchService
  let prefix: string

  beforeAll(async () => {
    connection = await prepareDatabase()
    prisma = createFixturePrismaClient(connection)
    prefix = prepareRedisPrefix()
    const config = MockConfigProvider.fromTenantConnectionUrl(connection, prefix)
    config.databaseConfig = {
      ...config.databaseConfig,
      retry: {
        maxAttempts: 8,
        initialDelayMs: 10,
        backoffFactor: 2,
        maxDelayMs: 100
      }
    }
    module = await Test.createTestingModule({imports: [ServiceModule.register({runtime: "worker"})]})
      // This slice exercises dispatch persistence and egress admission, without identity discovery.
      .overrideProvider(OidcBootstrapService)
      .useValue({onApplicationBootstrap: () => Promise.resolve()} satisfies Pick<
        OidcBootstrapService,
        "onApplicationBootstrap"
      >)
      .overrideProvider(ConfigProvider)
      .useValue(config)
      .compile()
    await module.init()
    tasks = module.get(TaskService)
    dispatch = module.get(DispatchService)
  }, 30000)
  afterAll(async () => {
    await module.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
    await cleanRedisByPrefix(prefix)
  }, 30000)

  async function fixture(
    status: "active" | "suspended" | "deleting" = "active",
    kind: "email" | "slack" | "webhook" = "email"
  ) {
    const organizationId = randomOrgId()
    const taskId = uuidv7()
    const now = new Date()
    await prisma.organization.create({
      data: {
        id: organizationId,
        slug: `dispatch-${organizationId}`,
        displayName: "Dispatch lifecycle",
        status,
        planTier: "FREE",
        occ: 0n,
        createdAt: now,
        updatedAt: now
      }
    })
    await prisma.durableWork.create({
      data: {
        id: taskId,
        organizationId,
        kind,
        state: "ready",
        fencing: 0n,
        attempts: 0,
        occ: 0n,
        availableAt: now,
        createdAt: now,
        updatedAt: now
      }
    })
    return {context: {organizationId}, taskId}
  }

  afterEach(() => {
    jest.restoreAllMocks()
  })

  async function commitEmailEvent(context: Awaited<ReturnType<typeof fixture>>["context"], taskId: string) {
    const event: TaskReadyEvent = {
      type: "task.ready",
      schemaVersion: 1,
      eventId: uuidv7(),
      organizationId: context.organizationId,
      taskId,
      taskKind: "email",
      taskOcc: 0n
    }
    const now = new Date()
    await prisma.tenantOutbox.create({
      data: {
        id: uuidv7(),
        organizationId: event.organizationId,
        eventId: event.eventId,
        eventType: event.type,
        schemaVersion: event.schemaVersion,
        resourceId: taskId,
        resourceVersion: event.taskOcc,
        payload: {...event, taskOcc: event.taskOcc.toString()},
        availableAt: now,
        createdAt: now,
        occ: 0n,
        attempts: 0n
      }
    })
    return event
  }

  it("validates a committed task event and rejects altered task details", async () => {
    // Given
    const {context, taskId} = await fixture()
    const event = await commitEmailEvent(context, taskId)

    // When
    const committed = await dispatch.validateEvent(event)()
    const changedTask = await dispatch.validateEvent({...event, taskId: uuidv7()})()
    const changedVersion = await dispatch.validateEvent({...event, taskOcc: event.taskOcc + 1n})()

    // Expect
    expect(committed).toBeRight()
    expect(changedTask).toBeLeftOf("event_mismatch")
    expect(changedVersion).toBeLeftOf("event_mismatch")
  })

  it.each(["claim", "recoverExpired", "parkReady"] as const)(
    "rejects a task-kind mismatch during %s without changing work",
    async operation => {
      // Given
      const {context, taskId} = await fixture()
      const before = await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})
      const operations = {
        claim: () => dispatch.claim(context, taskId, "slack", uuidv7(), new Date())(),
        recoverExpired: () => dispatch.recoverExpired(context, taskId, "slack", new Date())(),
        parkReady: () => dispatch.parkReady(context, taskId, "slack")()
      }

      // When
      const result = await operations[operation]()

      // Expect
      expect(result).toBeLeftOf("task_not_found")
      expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toEqual(before)
      expect(await prisma.dispatchAttempt.count({where: {organizationId: context.organizationId, taskId}})).toBe(0)
    }
  )

  it.each([99, 600, 200.5])("rejects invalid HTTP status %s without completing work", async statusCode => {
    // Given
    const {context, taskId} = await fixture("active", "webhook")
    const claim = unwrapRight(await dispatch.claim(context, taskId, "webhook", uuidv7(), new Date())())
    unwrapRight(await dispatch.startExecution(context, claim.attemptId, claim.lease)())
    const before = await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})
    const attempt = await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})

    // When
    const result = await dispatch.complete(
      context,
      claim.attemptId,
      claim.lease,
      {state: "failed", outcome: {type: "http_response", statusCode}},
      uuidv7()
    )()

    // Expect
    expect(result).toBeLeftOf("dispatch_invalid_http_status")
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toEqual(before)
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})).toEqual(attempt)
  })

  it("rejects recovery of a live lease and reports a missing attempt", async () => {
    // Given
    const {context, taskId} = await fixture()
    const now = new Date()
    const claim = unwrapRight(await dispatch.claim(context, taskId, "email", uuidv7(), now)())
    const before = await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})

    // When
    const recovery = await dispatch.recoverExpired(context, taskId, "email", now)()
    const validation = await dispatch.validateAttemptLease(context, uuidv7(), claim.lease)()

    // Expect
    expect(recovery).toBeLeftOf("dispatch_lease_not_expired")
    expect(validation).toBeLeftOf("dispatch_attempt_not_found")
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toEqual(before)
  })

  it("reports already parked work without changing it", async () => {
    // Given
    const {context, taskId} = await fixture()
    unwrapRight(await dispatch.parkReady(context, taskId, "email")())
    const before = await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})

    // When
    const result = await dispatch.parkReady(context, taskId, "email")()

    // Expect
    expect(result).toBeLeftOf("dispatch_work_already_paused")
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toEqual(before)
  })

  it.each([true, false])("records a task-load failure with retryable=%s", async retryable => {
    // Given
    const {context, taskId} = await fixture()
    const event = await commitEmailEvent(context, taskId)
    const claim = unwrapRight(await dispatch.claim(context, taskId, "email", uuidv7(), new Date())())

    // When
    const result = await dispatch.complete(
      context,
      claim.attemptId,
      claim.lease,
      {
        state: "failed",
        outcome: {
          type: "task_load_failed",
          error: {code: retryable ? "task_load_transaction_conflict" : "ciphertext_context_mismatch", retryable}
        }
      },
      event.eventId
    )()

    // Expect
    expect(result).toBeRight()
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toMatchObject({
      state: retryable ? "retry_due" : "failed"
    })
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})).toMatchObject({
      state: "failed"
    })
    expect(
      await prisma.tenantEventReceipt.count({
        where: {organizationId: context.organizationId, eventId: event.eventId, consumer: "task_dispatch"}
      })
    ).toBe(retryable ? 0 : 1)
  })

  it("preserves confirmed delivery when receipt storage returns a dependency error", async () => {
    // Given
    const {context, taskId} = await fixture()
    const event = await commitEmailEvent(context, taskId)
    const claim = unwrapRight(await dispatch.claim(context, taskId, "email", uuidv7(), new Date())())
    unwrapRight(await dispatch.startExecution(context, claim.attemptId, claim.lease)())
    const receipts = module.get<EventReceiptRepository>(EVENT_RECEIPT_REPOSITORY_TOKEN)
    jest.spyOn(receipts, "record").mockReturnValueOnce(TE.left("repository_dependency_error"))

    // When
    const result = await dispatch.complete(
      context,
      claim.attemptId,
      claim.lease,
      {state: "succeeded", outcome: {type: "delivered"}},
      event.eventId
    )()

    // Expect
    expect(result).toBeRight()
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toMatchObject({state: "succeeded"})
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})).toMatchObject({
      state: "succeeded",
      outcomeCategory: "delivered"
    })
    expect(
      await prisma.tenantEventReceipt.count({where: {organizationId: context.organizationId, eventId: event.eventId}})
    ).toBe(0)
  })

  it.each(["suspended", "deleting"] as const)("parks new work for a %s organization at admission", async status => {
    // Given
    const {context, taskId} = await fixture(status)
    // When
    const result = await tasks.claimDispatch(context, taskId, "email", uuidv7())()
    // Expect
    expect(result).toBeRight()
    expect(unwrapRight(result)).toMatchObject({state: "parked"})
    const work = await prisma.durableWork.findUniqueOrThrow({
      where: {organizationId_id: {organizationId: context.organizationId, id: taskId}}
    })
    expect(work.state).toBe("paused")
    expect(work.attempts).toBe(0)
    expect(await prisma.dispatchAttempt.count({where: {organizationId: context.organizationId, taskId}})).toBe(0)
  })

  it("admits only four deliveries from a simultaneous burst and releases permits after persisting outcomes", async () => {
    // Given: ten ready tasks compete for four slots; admitted deliveries remain in progress.
    const {context, taskId} = await fixture()
    const fifthTaskId = uuidv7()
    const taskIds = [
      taskId,
      ...Array.from({length: 3}, () => uuidv7()),
      fifthTaskId,
      ...Array.from({length: 5}, () => uuidv7())
    ]
    const now = new Date()
    await prisma.durableWork.createMany({
      data: taskIds.slice(1).map(id => ({
        id,
        organizationId: context.organizationId,
        kind: "email",
        state: "ready",
        fencing: 0n,
        attempts: 0,
        occ: 0n,
        availableAt: now,
        createdAt: now,
        updatedAt: now
      }))
    })
    let releaseDeliveries = () => {}
    const deliveryGate = new Promise<void>(resolve => {
      releaseDeliveries = resolve
    })
    let admitted = 0
    let rejected = 0
    let allAdmitted = () => {}
    const admissionGate = new Promise<void>(resolve => {
      allAdmitted = resolve
    })
    const executions = taskIds.map(id =>
      tasks
        .withDeliveryPermit(context, id, "email", uuidv7(), (claim, validateOwnership) => async () => {
          const executing = await tasks.startDispatchExecution(context, claim.attemptId, claim.lease)()
          if (isLeft(executing)) return executing
          const lease = await validateOwnership()
          if (isLeft(lease)) return lease
          admitted += 1
          if (admitted === 4 && rejected === 6) allAdmitted()
          await deliveryGate
          return await dispatch.complete(
            context,
            claim.attemptId,
            claim.lease,
            {
              state: "succeeded",
              outcome: {type: "delivered"}
            },
            uuidv7()
          )()
        })()
        .then(result => {
          if (isLeft(result)) {
            rejected++
            if (admitted === 4 && rejected === 6) allAdmitted()
          }
          return result
        })
    )
    try {
      // Settle all six rejections before altering Redis state below.
      await Promise.race([
        admissionGate,
        Promise.all(executions).then(results => results.forEach(result => unwrapRight(result)))
      ])
      // When: another task attempts admission while all organization slots are occupied.
      await expect(
        tasks.withDeliveryPermit(context, fifthTaskId, "email", uuidv7(), () =>
          TE.left("A fifth delivery must not execute")
        )()
      ).resolves.toBeLeftOf("capacity_exceeded")
      // Given: Redis loses its occupancy while the four original database leases remain live.
      const redis = module.get(RedisClient)
      await redis.del(
        `${prefix}dispatch:{${context.organizationId}}:expiry`,
        `${prefix}dispatch:{${context.organizationId}}:holders`,
        `${prefix}dispatch:{${context.organizationId}}:fencing`
      )
      // Expect: the durable admission guard rejects a fifth execution despite the empty cache.
      await expect(
        tasks.withDeliveryPermit(context, fifthTaskId, "email", uuidv7(), () =>
          TE.left("A fifth delivery must not execute after Redis loss")
        )()
      ).resolves.toBeLeftOf("capacity_exceeded")
      // A different organization can still complete while this organization remains saturated.
      const other = await fixture()
      const otherDelivery = await tasks.withDeliveryPermit(
        other.context,
        other.taskId,
        "email",
        uuidv7(),
        (claim, validateOwnership) => async () => {
          const executing = await tasks.startDispatchExecution(other.context, claim.attemptId, claim.lease)()
          if (isLeft(executing)) return executing
          const lease = await validateOwnership()
          if (isLeft(lease)) return lease
          return await dispatch.complete(
            other.context,
            claim.attemptId,
            claim.lease,
            {
              state: "succeeded",
              outcome: {type: "delivered"}
            },
            uuidv7()
          )()
        }
      )()
      expect(otherDelivery).toBeRight()
      expect(
        (
          await prisma.durableWork.findUniqueOrThrow({
            where: {
              organizationId_id: {organizationId: other.context.organizationId, id: other.taskId}
            }
          })
        ).state
      ).toBe("succeeded")
      // Expect: limiter rejection happens before creating a database attempt.
      expect(await prisma.dispatchAttempt.count({where: {organizationId: context.organizationId}})).toBe(4)
      expect(
        (
          await prisma.durableWork.findUniqueOrThrow({
            where: {
              organizationId_id: {organizationId: context.organizationId, id: fifthTaskId}
            }
          })
        ).state
      ).toBe("ready")
    } finally {
      releaseDeliveries()
      const results = await Promise.all(executions)
      expect(results.filter(E.isRight)).toHaveLength(4)
      expect(results.filter(E.isLeft).map(result => result.left)).toEqual(Array(6).fill("capacity_exceeded"))
    }
    expect(await module.get(RedisClient).zcard(`${prefix}dispatch:{${context.organizationId}}:expiry`)).toBe(0)
    expect(await prisma.durableWork.count({where: {organizationId: context.organizationId, state: "succeeded"}})).toBe(
      4
    )
  })

  it("preserves the claimed lease deadline through execution startup and ownership validation", async () => {
    // Given: Ready work whose lease is managed by the real dispatch service and database.
    const {context, taskId} = await fixture()
    const where = {organizationId_id: {organizationId: context.organizationId, id: taskId}}

    // When: Claim the task, start execution, then validate ownership before delivery.
    const claim = unwrapRight(await dispatch.claim(context, taskId, "email", uuidv7(), new Date())())
    const claimedWork = await prisma.durableWork.findUniqueOrThrow({where})
    unwrapRight(await dispatch.startExecution(context, claim.attemptId, claim.lease)())
    const executingWork = await prisma.durableWork.findUniqueOrThrow({where})
    unwrapRight(await dispatch.validateAttemptLease(context, claim.attemptId, claim.lease)())
    const validatedWork = await prisma.durableWork.findUniqueOrThrow({where})

    // Expect: Execution retains the original deadline; validation does not mutate work.
    expect(claimedWork).toMatchObject({state: "claimed", leaseUntil: claim.lease.expiresAt})
    expect(executingWork).toMatchObject({state: "executing", leaseUntil: claim.lease.expiresAt})
    expect(validatedWork).toEqual(executingWork)
  })

  it("retries a task-load failure when the adapter marks it retryable", async () => {
    // Given
    const {context, taskId} = await fixture()
    const claim = unwrapRight(await dispatch.claim(context, taskId, "email", uuidv7(), new Date())())
    const eventId = uuidv7()

    // When
    const result = await dispatch.complete(
      context,
      claim.attemptId,
      claim.lease,
      {state: "failed", outcome: {type: "task_load_failed", error: {code: "decryption_failed", retryable: true}}},
      eventId
    )()

    // Expect
    expect(result).toBeRight()
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toMatchObject({
      state: "retry_due",
      leaseOwner: null,
      leaseUntil: null
    })
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})).toMatchObject({
      state: "failed",
      outcomeCategory: "decryption_failed"
    })
    expect(await prisma.tenantEventReceipt.count({where: {organizationId: context.organizationId, eventId}})).toBe(0)

    // When
    const retry = await dispatch.claim(context, taskId, "email", uuidv7(), new Date())()

    // Expect
    expect(unwrapRight(retry).lease.fencing).toBeGreaterThan(claim.lease.fencing)
  })

  it("rejects an attempt missing execution metadata without changing the work", async () => {
    // Given
    const {context, taskId} = await fixture()
    const claim = unwrapRight(await dispatch.claim(context, taskId, "email", uuidv7(), new Date())())
    await prisma.dispatchAttempt.update({where: {id: claim.attemptId}, data: {state: "executing", executingAt: null}})
    const before = await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})

    // When
    const result = await dispatch.startExecution(context, claim.attemptId, claim.lease)()

    // Expect
    expect(result).toBeLeftOf("dispatch_attempt_invalid_executing_at")
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toEqual(before)
  })

  it("commits confirmed delivery even when its receipt insert fails the outbox foreign key", async () => {
    // Given: Executing work with confirmed delivery, but no outbox parent for its receipt.
    const {context, taskId} = await fixture()
    const claim = unwrapRight(await dispatch.claim(context, taskId, "email", uuidv7(), new Date())())
    unwrapRight(await dispatch.startExecution(context, claim.attemptId, claim.lease)())
    const eventId = uuidv7()

    // When: Completion persists success, then tries to insert the receipt in a separate transaction.
    const result = await dispatch.complete(
      context,
      claim.attemptId,
      claim.lease,
      {state: "succeeded", outcome: {type: "delivered"}},
      eventId
    )()

    // Expect: The real FK failure rolls back only the receipt transaction.
    expect(result).toBeRight()
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toMatchObject({state: "succeeded"})
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})).toMatchObject({
      state: "succeeded",
      outcomeCategory: "delivered"
    })
    expect(await prisma.tenantEventReceipt.count({where: {organizationId: context.organizationId, eventId}})).toBe(0)
  })

  it("checks ownership without extending the lease and releases the delivery permit when delivery fails", async () => {
    // Given
    const {context, taskId} = await fixture()
    const where = {organizationId_id: {organizationId: context.organizationId, id: taskId}}
    const failure = new Error("delivery failed")

    // When
    await expect(
      tasks.withDeliveryPermit<Error>(context, taskId, "email", uuidv7(), (claim, validateOwnership) => async () => {
        const executing = await tasks.startDispatchExecution(context, claim.attemptId, claim.lease)()
        if (isLeft(executing)) return executing
        const before = await prisma.durableWork.findUniqueOrThrow({where})
        const lease = await validateOwnership()
        if (isLeft(lease)) return lease

        // Expect
        const after = await prisma.durableWork.findUniqueOrThrow({where})
        expect(after.leaseUntil).toEqual(before.leaseUntil)
        expect(after.occ).toBe(before.occ)
        expect(after.fencing).toBe(before.fencing)
        return E.left(failure)
      })()
    ).resolves.toBeLeftOf(failure)
    expect(await module.get(RedisClient).zcard(`${prefix}dispatch:{${context.organizationId}}:expiry`)).toBe(0)
  })

  it("rejects egress after the database lease expires", async () => {
    // Given
    const {context, taskId} = await fixture()
    let egressStarted = false

    // When
    await expect(
      tasks.withDeliveryPermit(context, taskId, "email", uuidv7(), (_claim, validateOwnership) => async () => {
        await prisma.durableWork.update({
          where: {organizationId_id: {organizationId: context.organizationId, id: taskId}},
          data: {leaseUntil: new Date(0)}
        })
        const lease = await validateOwnership()
        if (isLeft(lease)) return lease
        egressStarted = true
        return E.right(undefined)
      })()
    ).resolves.toBeLeftOf("lease_lost")

    // Expect
    expect(egressStarted).toBe(false)
    expect(await module.get(RedisClient).zcard(`${prefix}dispatch:{${context.organizationId}}:expiry`)).toBe(0)
  })

  it.each(["parked", "completed"] as const)("releases the permit without delivering %s work", async state => {
    // Given
    const {context, taskId} = await fixture(state === "parked" ? "suspended" : "active")
    if (state === "completed") {
      const event = await commitEmailEvent(context, taskId)
      const claim = unwrapRight(await dispatch.claim(context, taskId, "email", uuidv7(), new Date())())
      unwrapRight(await dispatch.startExecution(context, claim.attemptId, claim.lease)())
      unwrapRight(
        await dispatch.complete(
          context,
          claim.attemptId,
          claim.lease,
          {state: "succeeded", outcome: {type: "delivered"}},
          event.eventId
        )()
      )
    }

    // When
    const result = await tasks.withDeliveryPermit(context, taskId, "email", uuidv7(), () =>
      TE.left("delivery must not start")
    )()

    // Expect
    expect(result).toBeRight()
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toMatchObject({
      state: state === "parked" ? "paused" : "succeeded"
    })
    expect(await prisma.dispatchAttempt.count({where: {organizationId: context.organizationId, taskId}})).toBe(
      state === "parked" ? 0 : 1
    )
    expect(await module.get(RedisClient).zcard(`${prefix}dispatch:{${context.organizationId}}:expiry`)).toBe(0)
  })

  it("releases the delivery permit when dispatch admission returns Left", async () => {
    // Given
    const {context, taskId} = await fixture()
    const failure = "repository_dependency_error"
    const admission = jest.spyOn(tasks, "claimDispatch").mockReturnValueOnce(TE.left(failure))

    try {
      // When
      await expect(
        tasks.withDeliveryPermit(context, taskId, "email", uuidv7(), () => TE.left("delivery must not start"))()
      ).resolves.toBeLeftOf(failure)

      // Expect
      expect(await module.get(RedisClient).zcard(`${prefix}dispatch:{${context.organizationId}}:expiry`)).toBe(0)
    } finally {
      admission.mockRestore()
    }
  })

  it("preserves the delivery failure when permit release returns Left", async () => {
    // Given
    const {context, taskId} = await fixture()
    const limiter = module.get<DeliveryConcurrencyLimiter>(DELIVERY_CONCURRENCY_LIMITER_TOKEN)
    const cleanup = jest.spyOn(limiter, "releasePermit").mockReturnValueOnce(TE.left("repository_dependency_error"))
    const failure = new Error("delivery failed")

    try {
      // When
      const delivery = tasks.withDeliveryPermit(context, taskId, "email", uuidv7(), () => TE.left(failure))()

      // Expect
      await expect(delivery).resolves.toBeLeftOf(failure)
      expect(cleanup).toHaveBeenCalledTimes(1)
    } finally {
      cleanup.mockRestore()
    }
  })

  it("rejects egress when permit ownership disappears after admission", async () => {
    // Given: the database attempt is admitted, then Redis loses this organization's limiter state.
    const {context, taskId} = await fixture()
    const redis = module.get(RedisClient)
    let egressStarted = false
    await expect(
      tasks.withDeliveryPermit(context, taskId, "email", uuidv7(), (_claim, validateOwnership) => async () => {
        await redis.del(
          `${prefix}dispatch:{${context.organizationId}}:expiry`,
          `${prefix}dispatch:{${context.organizationId}}:holders`
        )
        // When: the processor checks ownership immediately before its external call.
        const lease = await validateOwnership()
        if (isLeft(lease)) return lease
        egressStarted = true
        return E.right(undefined)
      })()
    ).resolves.toBeLeftOf("lease_lost")
    // Expect: losing limiter cannot authorize a new external side effect.
    expect(egressStarted).toBe(false)
  })

  it("recovers an abandoned pre-send claim and fences its original owner", async () => {
    // Given: a worker claimed a task but stopped before marking it sending.
    const {context, taskId} = await fixture()
    const original = requireAdmitted(unwrapRight(await tasks.claimDispatch(context, taskId, "email", uuidv7())()))
    await prisma.durableWork.update({
      where: {
        organizationId_id: {organizationId: context.organizationId, id: taskId}
      },
      data: {leaseUntil: new Date(0)}
    })
    // When: a restarted worker processes the same persisted task.
    const replacement = requireAdmitted(unwrapRight(await tasks.claimDispatch(context, taskId, "email", uuidv7())()))
    // Expect: the abandoned attempt is closed and the new attempt has a newer fencing token.
    expect(replacement.lease.fencing).toBeGreaterThan(original.lease.fencing)
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: original.attemptId}})).toMatchObject({
      state: "failed",
      outcomeCategory: "lease_expired"
    })
    expect(await tasks.startDispatchExecution(context, original.attemptId, original.lease)()).toBeLeftOf("lease_lost")
    expect(
      await dispatch.complete(
        context,
        original.attemptId,
        original.lease,
        {
          state: "succeeded",
          outcome: {type: "delivered"}
        },
        uuidv7()
      )()
    ).toBeLeftOf("lease_lost")
  })

  it.each(["email", "slack"] as const)(
    "parks abandoned %s delivery as unknown without creating another attempt",
    async kind => {
      // Given: a worker began an external delivery and then lost its lease before recording the outcome.
      const {context, taskId} = await fixture("active", kind)
      const original = requireAdmitted(unwrapRight(await tasks.claimDispatch(context, taskId, kind, uuidv7())()))
      unwrapRight(await tasks.startDispatchExecution(context, original.attemptId, original.lease)())
      const where = {organizationId_id: {organizationId: context.organizationId, id: taskId}}
      await prisma.durableWork.update({where, data: {leaseUntil: new Date(0)}})
      // When: restarted or replayed jobs attempt to process the same task.
      expect(unwrapRight(await tasks.claimDispatch(context, taskId, kind, uuidv7())())).toMatchObject({
        state: "parked"
      })
      expect(unwrapRight(await tasks.claimDispatch(context, taskId, kind, uuidv7())())).toMatchObject({
        state: "parked"
      })
      // Expect: the receiver may have accepted the first delivery, so automatic retry is forbidden.
      expect(await prisma.durableWork.findUniqueOrThrow({where})).toMatchObject({
        state: "unknown",
        leaseOwner: null,
        leaseUntil: null
      })
      expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: original.attemptId}})).toMatchObject({
        state: "unknown",
        outcomeCategory: "lease_expired"
      })
      expect(await prisma.dispatchAttempt.count({where: {organizationId: context.organizationId, taskId}})).toBe(1)
    }
  )

  it("recovers abandoned webhook sending ownership for an idempotent retry", async () => {
    // Given: webhook sending began but its outcome was not persisted before the lease expired.
    const {context, taskId} = await fixture("active", "webhook")
    const original = requireAdmitted(unwrapRight(await tasks.claimDispatch(context, taskId, "webhook", uuidv7())()))
    unwrapRight(await tasks.startDispatchExecution(context, original.attemptId, original.lease)())
    await prisma.durableWork.update({
      where: {
        organizationId_id: {organizationId: context.organizationId, id: taskId}
      },
      data: {leaseUntil: new Date(0)}
    })
    // When: a restarted worker claims the same task (the processor uses its immutable ID as Idempotency-Key).
    const replacement = requireAdmitted(unwrapRight(await tasks.claimDispatch(context, taskId, "webhook", uuidv7())()))
    // Expect: the uncertain attempt remains recorded while a fenced replacement is admitted.
    expect(replacement.lease.fencing).toBeGreaterThan(original.lease.fencing)
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: original.attemptId}})).toMatchObject({
      state: "unknown",
      outcomeCategory: "lease_expired"
    })
    expect(
      await dispatch.complete(
        context,
        original.attemptId,
        original.lease,
        {
          state: "succeeded",
          outcome: {type: "delivered"}
        },
        uuidv7()
      )()
    ).toBeLeftOf("lease_lost")
  })

  it("records an abandoned webhook as unknown during suspension without admitting a replacement", async () => {
    // Given: delivery began while active; the organization then suspended and its worker lease expired.
    const {context, taskId} = await fixture("active", "webhook")
    const original = requireAdmitted(unwrapRight(await tasks.claimDispatch(context, taskId, "webhook", uuidv7())()))
    unwrapRight(await tasks.startDispatchExecution(context, original.attemptId, original.lease)())
    await prisma.organization.update({where: {id: context.organizationId}, data: {status: "suspended"}})
    await prisma.durableWork.update({
      where: {
        organizationId_id: {organizationId: context.organizationId, id: taskId}
      },
      data: {leaseUntil: new Date(0)}
    })
    // When: a restarted worker encounters the abandoned task while new dispatch remains forbidden.
    expect(unwrapRight(await tasks.claimDispatch(context, taskId, "webhook", uuidv7())())).toMatchObject({
      state: "parked"
    })
    // Expect: restricted reconciliation records uncertainty without granting a new sending lease.
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: original.attemptId}})).toMatchObject({
      state: "unknown",
      outcomeCategory: "lease_expired"
    })
    expect(await prisma.dispatchAttempt.count({where: {organizationId: context.organizationId, taskId}})).toBe(1)
  })

  it("exposes only context-bound, read-only organization metadata to a worker login", async () => {
    const {context} = await fixture("suspended")
    const other = await fixture("active")
    const url = new URL(connection)
    url.username = "approvio_worker"
    const runtime = createFixturePrismaClient(url.toString())
    try {
      await expect(runtime.$queryRaw`SELECT status FROM organizations`).rejects.toThrow(/permission denied/)
      const rows = await runtime.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE approvio_worker_runtime")
        await tx.$queryRaw`SELECT set_config('approvio.organization_id', ${context.organizationId}, true)`
        return tx.$queryRaw<Array<{id: string; status: string}>>`
          SELECT id, status FROM organizations
          WHERE id = ${context.organizationId}::uuid
        `
      })
      expect(rows).toEqual([{id: context.organizationId, status: "suspended"}])
      const otherOrganization = await runtime.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE approvio_worker_runtime")
        await tx.$queryRaw`SELECT set_config('approvio.organization_id', ${context.organizationId}, true)`
        return tx.$queryRaw<Array<{id: string; status: string}>>`
          SELECT id, status FROM organizations WHERE id = ${other.context.organizationId}::uuid
        `
      })
      expect(otherOrganization).toHaveLength(0)
      await expect(
        runtime.$transaction(async tx => {
          await tx.$executeRawUnsafe("SET LOCAL ROLE approvio_worker_runtime")
          await tx.$queryRaw`SELECT set_config('approvio.organization_id', ${context.organizationId}, true)`
          return tx.$queryRaw`SELECT slug FROM organizations WHERE id = ${context.organizationId}::uuid`
        })
      ).rejects.toThrow(/permission denied/)
      await expect(
        runtime.$transaction(async tx => {
          await tx.$executeRawUnsafe("SET LOCAL ROLE approvio_worker_runtime")
          await tx.$queryRaw`SELECT set_config('approvio.organization_id', ${context.organizationId}, true)`
          return tx.$executeRaw`UPDATE organizations SET status = 'active' WHERE id = ${context.organizationId}::uuid`
        })
      ).rejects.toThrow(/permission denied/)
      await expect(
        runtime.$transaction(async tx => {
          await tx.$executeRawUnsafe("SET LOCAL ROLE approvio_worker_runtime")
          await tx.$queryRaw`SELECT set_config('approvio.organization_id', ${context.organizationId}, true)`
          return tx.$executeRaw`UPDATE organizations SET id = ${context.organizationId}::uuid WHERE id = ${context.organizationId}::uuid`
        })
      ).rejects.toThrow(/permission denied/)
      const missingContext = await runtime.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE approvio_worker_runtime")
        return tx.$queryRaw<Array<{id: string; status: string}>>`
          SELECT id, status FROM organizations
          WHERE id = NULLIF(current_setting('approvio.organization_id', true), '')::uuid
        `
      })
      expect(missingContext).toHaveLength(0)
    } finally {
      await runtime.$disconnect()
    }
  })

  it.each(["suspended", "deleting"] as const)(
    "allows admitted work to start after organization becomes %s",
    async status => {
      // Given
      const {context, taskId} = await fixture()
      const admitted = requireAdmitted(unwrapRight(await tasks.claimDispatch(context, taskId, "email", uuidv7())()))
      await prisma.organization.update({
        where: {id: context.organizationId},
        data: {status, occ: {increment: 1}}
      })
      // When
      const result = await tasks.startDispatchExecution(context, admitted.attemptId, admitted.lease)()
      // Expect
      expect(result).toBeRight()
      const attempt = await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: admitted.attemptId}})
      expect(attempt.state).toBe("executing")
      expect(attempt.outcomeCategory).toBeNull()
      expect(attempt.executingAt).toBeInstanceOf(Date)
    }
  )

  it("allows completion of already sending work after suspension", async () => {
    const {context, taskId} = await fixture()
    const admitted = requireAdmitted(unwrapRight(await tasks.claimDispatch(context, taskId, "email", uuidv7())()))
    unwrapRight(await tasks.startDispatchExecution(context, admitted.attemptId, admitted.lease)())
    await prisma.organization.update({
      where: {id: context.organizationId},
      data: {status: "suspended", occ: {increment: 1}}
    })
    unwrapRight(
      await dispatch.complete(
        context,
        admitted.attemptId,
        admitted.lease,
        {
          state: "succeeded",
          outcome: {type: "delivered"}
        },
        uuidv7()
      )()
    )
    const attempt = await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: admitted.attemptId}})
    expect(attempt.state).toBe("succeeded")
  })

  it("may admit work while a suspension is uncommitted", async () => {
    const {context, taskId} = await fixture()
    await prisma.$transaction(async tx => {
      await tx.organization.update({
        where: {id: context.organizationId},
        data: {status: "suspended", occ: {increment: 1}}
      })
      const result = unwrapRight(await tasks.claimDispatch(context, taskId, "email", uuidv7())())
      expect(result.state).toBe("admitted")
    })
    expect(await prisma.dispatchAttempt.count({where: {organizationId: context.organizationId}})).toBe(1)
  })
})

function requireAdmitted(result: DispatchClaimResult) {
  if (result.state !== "admitted") throw new Error("Expected admitted dispatch")
  return result
}
