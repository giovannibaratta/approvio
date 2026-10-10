import {Test, TestingModule} from "@nestjs/testing"
import {Prisma, PrismaClient} from "@prisma/client"
import {ConfigProvider} from "@external/config"
import {DatabaseClient} from "@external/database/database-client"
import {getQueueToken} from "@nestjs/bull"
import {Queue} from "bull"
import {USAGE_SETTLEMENT_QUEUE} from "@external/queue/queue.module"
import {TenantEventQueuePayload} from "@external/queue/tenant-event-payload"
import {MockConfigProvider} from "@test/mock-data"
import {
  createFixturePrismaClient,
  prepareDatabase,
  dropPreparedDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {randomOrgId} from "@test/organization-id"
import {TaskService} from "@services/task/task.service"
import {WorkflowRecalculationService} from "@services/workflow/workflow-recalculation.service"
import {UsageCacheRecoveryProcessor} from "../../src/processor/usage-cache-recovery.processor"
import {QUOTA_ADMISSION_CLIENT_TOKEN, QuotaAdmissionClient} from "@services/usage-metering/interfaces"
import {UsageOperationFactory} from "@services/durable-work/models"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WorkerModule} from "../../src/worker.module"
import {unwrapRight} from "@utils/either"
import {generateDeterministicId} from "@utils/uuid"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("restricted worker composition", () => {
  let connection: string
  let prefix: string
  let module: TestingModule
  let prisma: PrismaClient

  beforeAll(async () => {
    connection = await prepareDatabase()
    prefix = prepareRedisPrefix()
    prisma = createFixturePrismaClient(connection)
    const workerUrl = new URL(connection)
    workerUrl.username = "approvio_worker"
    const config = MockConfigProvider.fromTenantConnectionUrl(workerUrl.toString(), prefix)
    // Worker startup has no login-provider discovery requirement in this fixture.
    config.oidcProviders = new Map()
    module = await Test.createTestingModule({imports: [WorkerModule]})
      .overrideProvider(ConfigProvider)
      .useValue(config)
      .compile()
    await module.init()
  }, 30_000)

  afterAll(async () => {
    await module?.close()
    await prisma?.$disconnect()
    if (connection) await dropPreparedDatabase(connection)
    if (prefix) await cleanRedisByPrefix(prefix)
  }, 30_000)

  it("rebuilds and reconciles committed usage under worker credentials without changing billing facts", async () => {
    // Given: fixture administration commits a settled operation, immutable charge and pending cache acknowledgement.
    const organizationId = randomOrgId()
    const now = new Date()
    await prisma.organization.create({
      data: {
        id: organizationId,
        slug: `meter-${organizationId}`,
        displayName: "Restricted meter",
        status: "active",
        planTier: "FREE",
        occ: 0n,
        createdAt: now,
        updatedAt: now
      }
    })
    const operation = unwrapRight(
      UsageOperationFactory.validate({
        organizationId,
        operationId: uuidv7(),
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        period: "2026-10",
        entityType: "WORKFLOW",
        entityId: uuidv7(),
        actor: {type: "user", id: uuidv7(), displayName: "Meter"},
        estimatedUnits: 10,
        isBillable: true
      })
    )
    await prisma.usageOperation.create({
      data: {
        id: uuidv7(),
        organizationId,
        operationId: operation.operationId,
        metric: operation.metric,
        period: operation.period,
        entityType: operation.entityType,
        entityId: operation.entityId,
        actorType: operation.actor.type,
        actorId: operation.actor.id,
        actorDisplayName: operation.actor.displayName,
        estimatedUnits: 10n,
        actualUnits: 7n,
        isBillable: true,
        status: "settled",
        requestDigest: "0".repeat(64),
        createdAt: now,
        updatedAt: now,
        occ: 1n
      }
    })
    const chargeData = {
      id: generateDeterministicId(`usage-event-${organizationId}-${operation.operationId}`),
      organizationId,
      metric: operation.metric,
      entityType: operation.entityType,
      entityId: operation.entityId,
      actorType: operation.actor.type,
      actorId: operation.actor.id,
      actorDisplayName: operation.actor.displayName,
      quantity: 7n,
      isBillable: true,
      occurredAt: now
    } satisfies Prisma.UsageEventUncheckedCreateInput
    const charge = await prisma.usageEvent.create({data: chargeData})
    const intent = await prisma.usageSettlementIntent.create({
      data: {
        id: uuidv7(),
        organizationId,
        operationId: operation.operationId,
        revision: 1n,
        desiredStatus: "settled",
        actualUnits: 7n,
        availableAt: now,
        attempts: 0,
        createdAt: now
      }
    })
    // When: the actual worker processor restores its empty Redis cache from committed database facts.
    await module.get(UsageCacheRecoveryProcessor).rebuild({
      data: {
        organizationId,
        metric: operation.metric,
        period: operation.period
      }
    })
    const event: TenantEventQueuePayload = {
      schemaVersion: 1,
      type: "usage.settlement",
      organizationId,
      eventId: generateDeterministicId(`usage-settlement-${organizationId}-${operation.operationId}-1`),
      operationId: operation.operationId,
      operationOcc: "1"
    }
    const queue = module.get<Queue<TenantEventQueuePayload>>(getQueueToken(USAGE_SETTLEMENT_QUEUE))
    const job = await queue.add(event.type, event, {attempts: 1, removeOnComplete: false})
    await job.finished()
    const acknowledged = await prisma.usageSettlementIntent.findUniqueOrThrow({where: {id: intent.id}})
    // A separately enqueued replay reaches the processor again rather than being deduplicated by Bull job ID.
    const replay = await queue.add(event.type, event, {attempts: 1, removeOnComplete: false})
    await replay.finished()
    // Expect: real Bull consumption acknowledges reconciliation without charging the operation again.
    expect(acknowledged.appliedAt).not.toBeNull()
    expect((await prisma.usageSettlementIntent.findUniqueOrThrow({where: {id: intent.id}})).appliedAt).toEqual(
      acknowledged.appliedAt
    )
    const cache = module.get<QuotaAdmissionClient>(QUOTA_ADMISSION_CLIENT_TOKEN)
    expect(
      unwrapRight(await cache.getUsage(`${prefix}usage:${organizationId}:${operation.metric}:${operation.period}`)())
    ).toEqual({consumed: 7, reserved: 0})
    expect(await prisma.usageEvent.findUniqueOrThrow({where: {id: charge.id}})).toEqual(charge)
    expect(await prisma.usageEvent.count({where: {organizationId}})).toBe(1)

    // The same worker cannot invent charges, change measured units or rewrite a settlement's requested outcome.
    const database = module.get(DatabaseClient)
    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({
      data: {
        id: otherOrganizationId,
        slug: `meter-${otherOrganizationId}`,
        displayName: "Other meter",
        status: "active",
        planTier: "FREE",
        occ: 0n,
        createdAt: now,
        updatedAt: now
      }
    })
    await prisma.usageEvent.create({data: {...chargeData, id: uuidv7(), organizationId: otherOrganizationId}})
    // RLS, rather than a caller-supplied WHERE filter, excludes another organization's billing facts.
    expect(await database.transactional(organizationId, tx => tx.usageEvent.findMany({select: {id: true}}))).toEqual([
      {id: charge.id}
    ])
    expect(await database.transactional(otherOrganizationId, tx => tx.usageOperation.findMany())).toHaveLength(0)
    expect(
      await database.transactional(otherOrganizationId, tx =>
        tx.usageSettlementIntent.updateMany({
          where: {id: intent.id},
          data: {appliedAt: new Date(0)}
        })
      )
    ).toEqual({count: 0})
    expect((await prisma.usageSettlementIntent.findUniqueOrThrow({where: {id: intent.id}})).appliedAt).toEqual(
      acknowledged.appliedAt
    )
    await expect(
      database.transactional(organizationId, tx =>
        tx.usageEvent.create({
          data: {
            ...chargeData,
            id: uuidv7()
          }
        })
      )
    ).rejects.toThrow(/permission denied/)
    await expect(
      database.transactional(organizationId, tx =>
        tx.usageOperation.updateMany({
          where: {organizationId},
          data: {actualUnits: 99n}
        })
      )
    ).rejects.toThrow(/permission denied/)
    await expect(
      database.transactional(organizationId, tx =>
        tx.usageSettlementIntent.updateMany({
          where: {id: intent.id},
          data: {actualUnits: 99n}
        })
      )
    ).rejects.toThrow(/permission denied/)
  }, 15_000)

  it("starts under worker credentials and executes dispatch and expiration through the shared repositories", async () => {
    // Given: all real WorkerModule providers use the restricted worker login; fixture setup uses a separate client.
    const organizationId = randomOrgId()
    const taskId = uuidv7()
    const now = new Date()
    await prisma.organization.create({
      data: {
        id: organizationId,
        slug: `worker-${organizationId}`,
        displayName: "Restricted worker",
        status: "active",
        planTier: "FREE",
        occ: 0n,
        createdAt: now,
        updatedAt: now
      }
    })
    await prisma.durableWork.create({
      data: {
        organizationId,
        id: taskId,
        kind: "email",
        state: "ready",
        fencing: 0n,
        attempts: 0,
        occ: 0n,
        availableAt: now,
        createdAt: now,
        updatedAt: now
      }
    })
    const context = {organizationId}
    // When: dispatch uses its worker transaction binding.
    const claim = unwrapRight(await module.get(TaskService).claimDispatch(context, taskId, "email", uuidv7(), now)())
    // Expect: startup and the restricted dispatch path succeed without granting the worker tenant membership.
    expect(claim.state).toBe("admitted")
    await prisma.workflowExpirationSchedule.create({data: {organizationId, nextSweepAt: now}})
    // When: expiration enters the shared transaction/repository binding selected by worker composition.
    const schedule = await module
      .get(WorkflowRecalculationService)
      .getDueWorkflowExpirationSchedule(context, now, now)()
    // Expect: the worker can read its schedule without assuming the tenant API role.
    expect(unwrapRight(schedule)).toEqual({organizationId})

    // Given: workflow execution opens the shared transaction and then enters dispatch admission.
    const nestedTaskId = uuidv7()
    await prisma.durableWork.create({
      data: {
        organizationId,
        id: nestedTaskId,
        kind: "email",
        state: "ready",
        fencing: 0n,
        attempts: 0,
        occ: 0n,
        availableAt: now,
        createdAt: now,
        updatedAt: now
      }
    })
    const manager = module.get<TenantTransactionManager>(TRANSACTION_MANAGER_TOKEN)
    // When: the outer computation fails after the nested worker claim.
    const rolledBack = await manager.execute(
      context,
      () =>
        pipe(
          module.get(TaskService).claimDispatch(context, nestedTaskId, "email", uuidv7(), now),
          TE.chainW(() => TE.left("rollback_probe" as const))
        ),
      {isolationLevel: "Serializable"}
    )()
    // Expect: shared context rolls back both the work claim and its attempt.
    expect(rolledBack).toBeLeftOf("rollback_probe")
    expect(
      await prisma.durableWork.findUniqueOrThrow({
        where: {
          organizationId_id: {organizationId, id: nestedTaskId}
        }
      })
    ).toMatchObject({state: "ready", fencing: 0n, attempts: 0})
    expect(await prisma.dispatchAttempt.count({where: {durableWorkId: nestedTaskId}})).toBe(0)

    // Worker composition does not grant unrelated tenant capabilities or workflow content mutation.
    const database = module.get(DatabaseClient)
    await expect(database.transactional(organizationId, tx => tx.user.findMany())).rejects.toThrow(/permission denied/)
    await expect(
      database.transactional(organizationId, tx =>
        tx.workflowTemplate.updateMany({
          data: {name: "forbidden"}
        })
      )
    ).rejects.toThrow(/permission denied/)
    await expect(
      database.transactional(organizationId, tx =>
        tx.workflow.updateMany({
          data: {name: "forbidden"}
        })
      )
    ).rejects.toThrow(/permission denied/)

    // A nested worker client must not borrow broader API privileges from the ambient context.
    const api = new DatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connection,
        platformConnectionUrl: connection,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    try {
      await api.transactional(organizationId, async tx => {
        expect(await tx.$queryRaw`SELECT current_role AS role`).toEqual([{role: "approvio_tenant_runtime"}])
        const workerRole = await database.transactional(organizationId, cx => cx.$queryRaw`SELECT current_role AS role`)
        expect(workerRole).toEqual([{role: "approvio_worker_runtime"}])
        await expect(database.transactional(organizationId, cx => cx.user.findMany())).rejects.toThrow(
          /permission denied/
        )
        expect(await tx.$queryRaw`SELECT current_role AS role`).toEqual([{role: "approvio_tenant_runtime"}])
      })
    } finally {
      await api.onModuleDestroy()
    }
  })
})
