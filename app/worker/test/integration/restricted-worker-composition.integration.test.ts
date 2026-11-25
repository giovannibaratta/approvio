import {Test, TestingModule} from "@nestjs/testing"
import {Prisma, PrismaClient} from "@prisma/client"
import {ConfigProvider} from "@external/config"
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
import {UsageCacheRecoveryProcessor} from "../../src/processor/usage-cache-recovery.processor"
import {QUOTA_ADMISSION_CLIENT_TOKEN, QuotaAdmissionClient} from "@services/usage-metering/interfaces"
import {UsageOperationFactory} from "@services/durable-work/models"
import {WorkerModule} from "../../src/worker.module"
import {unwrapRight} from "@utils/either"
import {generateDeterministicId} from "@utils/uuid"
import {v7 as uuidv7} from "uuid"

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
        estimatedUnits: 10n,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
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
        expiresAt: operation.expiresAt,
        actualUnits: 7n,
        isBillable: true,
        status: "settled",
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
        createdAt: now,
        occ: 0n
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

    // Expect: recovery restores the committed charge to the cache.
    const cache = module.get<QuotaAdmissionClient>(QUOTA_ADMISSION_CLIENT_TOKEN)
    expect(
      unwrapRight(await cache.getUsage(`${prefix}usage:${organizationId}:${operation.metric}:${operation.period}`)())
    ).toEqual({consumed: 7n, reserved: 0n})

    // Given: a settlement event for the recovered operation.
    const event: TenantEventQueuePayload = {
      schemaVersion: 1,
      type: "usage.settlement",
      organizationId,
      eventId: generateDeterministicId(`usage-settlement-${organizationId}-${operation.operationId}-1`),
      operationId: operation.operationId
    }
    const queue = module.get<Queue<TenantEventQueuePayload>>(getQueueToken(USAGE_SETTLEMENT_QUEUE))

    // When: the worker consumes the event.
    const job = await queue.add(event.type, event, {attempts: 1, removeOnComplete: false})
    await job.finished()
    const acknowledged = await prisma.usageSettlementIntent.findUniqueOrThrow({where: {id: intent.id}})

    // Expect: reconciliation is acknowledged.
    expect(acknowledged.appliedAt).not.toBeNull()

    // When: a separately enqueued replay reaches the processor again.
    const replay = await queue.add(event.type, event, {attempts: 1, removeOnComplete: false})
    await replay.finished()

    // Expect: replay preserves the acknowledgement and does not create another charge.
    expect((await prisma.usageSettlementIntent.findUniqueOrThrow({where: {id: intent.id}})).appliedAt).toEqual(
      acknowledged.appliedAt
    )
    expect(
      unwrapRight(await cache.getUsage(`${prefix}usage:${organizationId}:${operation.metric}:${operation.period}`)())
    ).toEqual({consumed: 7n, reserved: 0n})
    expect(await prisma.usageEvent.findUniqueOrThrow({where: {id: charge.id}})).toEqual(charge)
    expect(await prisma.usageEvent.count({where: {organizationId}})).toBe(1)
  }, 15_000)
})
