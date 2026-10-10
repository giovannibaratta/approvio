import {OidcBootstrapService} from "@external/oidc/oidc-bootstrap.service"
import {DispatchClaimResult, DispatchLeaseClient, DISPATCH_LEASE_CLIENT_TOKEN} from "@services/durable-work/interfaces"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {ConfigProvider} from "@external/config"
import {RedisClient} from "@external/redis/redis-client"
import {ServiceModule} from "@services/service.module"
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
    module = await Test.createTestingModule({imports: [ServiceModule.register({runtime: "api"})]})
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

  it("bounds concurrent delivery execution and releases capacity after outcomes are persisted", async () => {
    // Given: five ready tasks in one organization, with four deliveries held in progress.
    const {context, taskId} = await fixture()
    const fifthTaskId = uuidv7()
    const taskIds = [taskId, ...Array.from({length: 3}, () => uuidv7()), fifthTaskId]
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
    let allAdmitted = () => {}
    const admissionGate = new Promise<void>(resolve => {
      allAdmitted = resolve
    })
    const executions = taskIds.slice(0, 4).map(id =>
      tasks.withDispatchLease(context, id, "email", uuidv7(), async (claim, assertLease) => {
        unwrapRight(await tasks.startDispatchExecution(context, claim.attemptId, claim.lease)())
        await assertLease()
        admitted += 1
        if (admitted === 4) allAdmitted()
        await deliveryGate
        unwrapRight(
          await tasks.completeDispatch(
            context,
            claim.attemptId,
            claim.lease,
            {
              state: "succeeded",
              outcome: {type: "delivered"}
            },
            uuidv7()
          )()
        )
      })
    )
    try {
      await Promise.race([admissionGate, Promise.all(executions)])
      // When: another task attempts admission while all organization slots are occupied.
      await expect(
        tasks.withDispatchLease(context, fifthTaskId, "email", uuidv7(), () =>
          Promise.reject(new Error("A fifth delivery must not execute"))
        )
      ).rejects.toThrow("capacity_exceeded")
      // Given: Redis loses its occupancy while the four original database leases remain live.
      const redis = module.get(RedisClient)
      await redis.del(
        `${prefix}dispatch:{${context.organizationId}}:expiry`,
        `${prefix}dispatch:{${context.organizationId}}:holders`,
        `${prefix}dispatch:{${context.organizationId}}:fencing`
      )
      // Expect: the durable admission guard rejects a fifth execution despite the empty cache.
      await expect(
        tasks.withDispatchLease(context, fifthTaskId, "email", uuidv7(), () =>
          Promise.reject(new Error("A fifth delivery must not execute after Redis loss"))
        )
      ).rejects.toThrow("Dispatch admission failed: capacity_exceeded")
      // A different organization can still complete while this organization remains saturated.
      const other = await fixture()
      await tasks.withDispatchLease(other.context, other.taskId, "email", uuidv7(), async (claim, assertLease) => {
        unwrapRight(await tasks.startDispatchExecution(other.context, claim.attemptId, claim.lease)())
        await assertLease()
        unwrapRight(
          await tasks.completeDispatch(
            other.context,
            claim.attemptId,
            claim.lease,
            {
              state: "succeeded",
              outcome: {type: "delivered"}
            },
            uuidv7()
          )()
        )
      })
      expect(
        (
          await prisma.durableWork.findUniqueOrThrow({
            where: {
              organizationId_id: {organizationId: other.context.organizationId, id: other.taskId}
            }
          })
        ).state
      ).toBe("succeeded")
      // Expect: capacity rejection happens before creating a database attempt.
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
      await Promise.all(executions)
    }
    expect(await module.get(RedisClient).zcard(`${prefix}dispatch:{${context.organizationId}}:expiry`)).toBe(0)
    expect(await prisma.durableWork.count({where: {organizationId: context.organizationId, state: "succeeded"}})).toBe(
      4
    )
  })

  it("checks ownership without extending the lease and releases capacity when delivery fails", async () => {
    // Given
    const {context, taskId} = await fixture()
    const where = {organizationId_id: {organizationId: context.organizationId, id: taskId}}
    const failure = new Error("delivery failed")

    // When
    await expect(
      tasks.withDispatchLease(context, taskId, "email", uuidv7(), async (claim, assertLease) => {
        unwrapRight(await tasks.startDispatchExecution(context, claim.attemptId, claim.lease)())
        const before = await prisma.durableWork.findUniqueOrThrow({where})
        await assertLease()

        // Expect
        const after = await prisma.durableWork.findUniqueOrThrow({where})
        expect(after.leaseUntil).toEqual(before.leaseUntil)
        expect(after.occ).toBe(before.occ)
        expect(after.fencing).toBe(before.fencing)
        throw failure
      })
    ).rejects.toBe(failure)
    expect(await module.get(RedisClient).zcard(`${prefix}dispatch:{${context.organizationId}}:expiry`)).toBe(0)
  })

  it("rejects egress after the database lease expires", async () => {
    // Given
    const {context, taskId} = await fixture()
    let egressStarted = false

    // When
    await expect(
      tasks.withDispatchLease(context, taskId, "email", uuidv7(), async (_claim, assertLease) => {
        await prisma.durableWork.update({
          where: {organizationId_id: {organizationId: context.organizationId, id: taskId}},
          data: {leaseUntil: new Date(0)}
        })
        await assertLease()
        egressStarted = true
      })
    ).rejects.toThrow("lease_lost")

    // Expect
    expect(egressStarted).toBe(false)
    expect(await module.get(RedisClient).zcard(`${prefix}dispatch:{${context.organizationId}}:expiry`)).toBe(0)
  })

  it("releases capacity when dispatch admission throws", async () => {
    // Given
    const {context, taskId} = await fixture()
    const failure = new Error("admission storage failed")
    const admission = jest.spyOn(tasks, "claimDispatch").mockReturnValueOnce(() => Promise.reject(failure))

    try {
      // When
      await expect(
        tasks.withDispatchLease(context, taskId, "email", uuidv7(), () =>
          Promise.reject(new Error("delivery must not start"))
        )
      ).rejects.toBe(failure)

      // Expect
      expect(await module.get(RedisClient).zcard(`${prefix}dispatch:{${context.organizationId}}:expiry`)).toBe(0)
    } finally {
      admission.mockRestore()
    }
  })

  it("preserves the delivery failure when capacity cleanup throws", async () => {
    // Given
    const {context, taskId} = await fixture()
    const capacity = module.get<DispatchLeaseClient>(DISPATCH_LEASE_CLIENT_TOKEN)
    const cleanup = jest
      .spyOn(capacity, "release")
      .mockReturnValueOnce(() => Promise.reject(new Error("Redis unavailable")))
    const failure = new Error("delivery failed")

    try {
      // When
      const delivery = tasks.withDispatchLease(context, taskId, "email", uuidv7(), () => Promise.reject(failure))

      // Expect
      await expect(delivery).rejects.toBe(failure)
      expect(cleanup).toHaveBeenCalledTimes(1)
    } finally {
      cleanup.mockRestore()
    }
  })

  it("rejects egress when capacity ownership disappears after admission", async () => {
    // Given: the database attempt is admitted, then Redis loses this organization's capacity state.
    const {context, taskId} = await fixture()
    const redis = module.get(RedisClient)
    let egressStarted = false
    await expect(
      tasks.withDispatchLease(context, taskId, "email", uuidv7(), async (_claim, assertLease) => {
        await redis.del(
          `${prefix}dispatch:{${context.organizationId}}:expiry`,
          `${prefix}dispatch:{${context.organizationId}}:holders`
        )
        // When: the processor checks ownership immediately before its external call.
        await assertLease()
        egressStarted = true
      })
    ).rejects.toThrow("lease_lost")
    // Expect: losing capacity cannot authorize a new external side effect.
    expect(egressStarted).toBe(false)
  })

  it("recovers an abandoned pre-send claim and fences its original owner", async () => {
    // Given: a worker claimed a task but stopped before marking it sending.
    const {context, taskId} = await fixture()
    const original = requireAdmitted(
      unwrapRight(await tasks.claimDispatch(context, taskId, "email", uuidv7(), new Date())())
    )
    await prisma.durableWork.update({
      where: {
        organizationId_id: {organizationId: context.organizationId, id: taskId}
      },
      data: {leaseUntil: new Date(0)}
    })
    // When: a restarted worker processes the same persisted task.
    const replacement = requireAdmitted(
      unwrapRight(await tasks.claimDispatch(context, taskId, "email", uuidv7(), new Date())())
    )
    // Expect: the abandoned attempt is closed and the new attempt has a newer fencing token.
    expect(replacement.lease.fencing).toBeGreaterThan(original.lease.fencing)
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: original.attemptId}})).toMatchObject({
      state: "failed",
      outcomeCategory: "lease_expired"
    })
    expect(await tasks.startDispatchExecution(context, original.attemptId, original.lease)()).toBeLeftOf("lease_lost")
    expect(
      await tasks.completeDispatch(
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
      const original = requireAdmitted(
        unwrapRight(await tasks.claimDispatch(context, taskId, kind, uuidv7(), new Date())())
      )
      unwrapRight(await tasks.startDispatchExecution(context, original.attemptId, original.lease)())
      const where = {organizationId_id: {organizationId: context.organizationId, id: taskId}}
      await prisma.durableWork.update({where, data: {leaseUntil: new Date(0)}})
      // When: restarted or replayed jobs attempt to process the same task.
      expect(unwrapRight(await tasks.claimDispatch(context, taskId, kind, uuidv7(), new Date())())).toMatchObject({
        state: "parked"
      })
      expect(unwrapRight(await tasks.claimDispatch(context, taskId, kind, uuidv7(), new Date())())).toMatchObject({
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
      expect(
        await prisma.dispatchAttempt.count({where: {organizationId: context.organizationId, durableWorkId: taskId}})
      ).toBe(1)
    }
  )

  it("recovers abandoned webhook sending ownership for an idempotent retry", async () => {
    // Given: webhook sending began but its outcome was not persisted before the lease expired.
    const {context, taskId} = await fixture("active", "webhook")
    const original = requireAdmitted(
      unwrapRight(await tasks.claimDispatch(context, taskId, "webhook", uuidv7(), new Date())())
    )
    unwrapRight(await tasks.startDispatchExecution(context, original.attemptId, original.lease)())
    await prisma.durableWork.update({
      where: {
        organizationId_id: {organizationId: context.organizationId, id: taskId}
      },
      data: {leaseUntil: new Date(0)}
    })
    // When: a restarted worker claims the same task (the processor uses its immutable ID as Idempotency-Key).
    const replacement = requireAdmitted(
      unwrapRight(await tasks.claimDispatch(context, taskId, "webhook", uuidv7(), new Date())())
    )
    // Expect: the uncertain attempt remains recorded while a fenced replacement is admitted.
    expect(replacement.lease.fencing).toBeGreaterThan(original.lease.fencing)
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: original.attemptId}})).toMatchObject({
      state: "unknown",
      outcomeCategory: "lease_expired"
    })
    expect(
      await tasks.completeDispatch(
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
    const original = requireAdmitted(
      unwrapRight(await tasks.claimDispatch(context, taskId, "webhook", uuidv7(), new Date())())
    )
    unwrapRight(await tasks.startDispatchExecution(context, original.attemptId, original.lease)())
    await prisma.organization.update({where: {id: context.organizationId}, data: {status: "suspended"}})
    await prisma.durableWork.update({
      where: {
        organizationId_id: {organizationId: context.organizationId, id: taskId}
      },
      data: {leaseUntil: new Date(0)}
    })
    // When: a restarted worker encounters the abandoned task while new dispatch remains forbidden.
    expect(unwrapRight(await tasks.claimDispatch(context, taskId, "webhook", uuidv7(), new Date())())).toMatchObject({
      state: "parked"
    })
    // Expect: restricted reconciliation records uncertainty without granting a new sending lease.
    expect(await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: original.attemptId}})).toMatchObject({
      state: "unknown",
      outcomeCategory: "lease_expired"
    })
    expect(
      await prisma.dispatchAttempt.count({where: {organizationId: context.organizationId, durableWorkId: taskId}})
    ).toBe(1)
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

  it("denies sending after suspension between claim and send", async () => {
    const {context, taskId} = await fixture()
    const admitted = requireAdmitted(
      unwrapRight(await tasks.claimDispatch(context, taskId, "email", uuidv7(), new Date())())
    )
    await prisma.organization.update({
      where: {id: context.organizationId},
      data: {status: "suspended", occ: {increment: 1}}
    })
    expect(await tasks.startDispatchExecution(context, admitted.attemptId, admitted.lease)()).toBeRightOf("parked")
    const attempt = await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: admitted.attemptId}})
    expect(attempt.state).toBe("failed")
    expect(attempt.outcomeCategory).toBe("organization_paused")
    expect(attempt.sendingAt).toBeNull()
  })

  it("allows completion of already sending work after suspension", async () => {
    const {context, taskId} = await fixture()
    const admitted = requireAdmitted(
      unwrapRight(await tasks.claimDispatch(context, taskId, "email", uuidv7(), new Date())())
    )
    unwrapRight(await tasks.startDispatchExecution(context, admitted.attemptId, admitted.lease)())
    await prisma.organization.update({
      where: {id: context.organizationId},
      data: {status: "suspended", occ: {increment: 1}}
    })
    unwrapRight(
      await tasks.completeDispatch(
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
      const result = unwrapRight(await tasks.claimDispatch(context, taskId, "email", uuidv7(), new Date())())
      expect(result.state).toBe("admitted")
    })
    expect(await prisma.dispatchAttempt.count({where: {organizationId: context.organizationId}})).toBe(1)
  })
})

function requireAdmitted(result: DispatchClaimResult) {
  if (result.state !== "admitted") throw new Error("Expected admitted dispatch")
  return result
}
