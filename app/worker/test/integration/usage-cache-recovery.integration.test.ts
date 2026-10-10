import {getQueueToken} from "@nestjs/bull"
import {Test, TestingModule} from "@nestjs/testing"
import {Queue} from "bull"
import {ConfigModule, QueueModule} from "@external"
import {ConfigProvider} from "@external/config"
import {BullQueueProvider} from "@external/queue/queue.provider"
import {USAGE_CACHE_RECOVERY_QUEUE} from "@external/queue/queue.module"
import {UsageCacheRecoveryRequest, UsageMeteringError, UsageMeteringService} from "@services/usage-metering"
import {UsageSettlementProcessor} from "../../src/processor/usage-settlement.processor"
import {TenantEventQueuePayload} from "@external/queue/tenant-event-payload"
import {USAGE_SETTLEMENT_QUEUE} from "@external/queue/queue.module"
import * as TE from "fp-ts/TaskEither"
import {v7 as uuidv7} from "uuid"
import {randomUUID} from "crypto"
import {MockConfigProvider} from "@test/mock-data"
import {cleanRedisByPrefix, prepareRedisPrefix} from "@test/database"
import {randomOrgId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"

// Exercise Bull's actual duplicate-job behavior, including delayed and active jobs.
describe("Usage cache recovery queue", () => {
  let module: TestingModule
  let queue: Queue<UsageCacheRecoveryRequest>
  let provider: BullQueueProvider
  let processing: Promise<void> | undefined
  const prefix = prepareRedisPrefix()
  const request: UsageCacheRecoveryRequest = {
    organizationId: randomOrgId(),
    metric: "MAX_LLM_TOKENS_PER_MONTH",
    period: "2026-10"
  }
  const id = `${request.organizationId}:${request.metric}:${request.period}`

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule, QueueModule],
      providers: [
        BullQueueProvider,
        UsageSettlementProcessor,
        {
          provide: UsageMeteringService,
          useValue: {applySettlement: () => TE.left<UsageMeteringError, void>("quota_cache_unavailable")}
        }
      ]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromOriginalProvider({redisPrefix: prefix}))
      .compile()
    provider = module.get(BullQueueProvider)
    queue = module.get(getQueueToken(USAGE_CACHE_RECOVERY_QUEUE))
    // Skip application repeatable-job registration; these tests use only recovery jobs.
    await queue.isReady()
  })

  afterEach(async () => {
    const job = await queue.getJob(id)
    if (job) await job.remove()
    await queue.empty()
  })
  afterAll(async () => {
    await module.close()
    await processing
    await cleanRedisByPrefix(prefix)
  })

  it("coalesces parallel requests at fixed urgent priority", async () => {
    await Promise.all(
      Array.from({length: 20}, async () => unwrapRight(await provider.requestUsageCacheRecovery(request)()))
    )
    expect(await queue.getWaitingCount()).toBe(1)
    const job = await queue.getJob(id)
    if (!job) throw new Error("Recovery job missing")
    expect(job.opts).toMatchObject({priority: 1, removeOnComplete: true, removeOnFail: true})
  })

  it("leaves a delayed recovery in place on repeated requests", async () => {
    await queue.add("rebuild-usage-cache", request, {jobId: id, delay: 60000, priority: 1})
    unwrapRight(await provider.requestUsageCacheRecovery(request)())
    expect(await queue.getDelayedCount()).toBe(1)
    expect(await queue.getWaitingCount()).toBe(0)
  })

  it("deduplicates active jobs and permits another recovery after completion", async () => {
    let release = () => {}
    const hold = new Promise<void>(resolve => {
      release = resolve
    })
    let started = () => {}
    const active = new Promise<void>(resolve => {
      started = resolve
    })
    processing = queue.process("rebuild-usage-cache", async () => {
      started()
      await hold
    })
    unwrapRight(await provider.requestUsageCacheRecovery(request)())
    await active
    const job = await queue.getJob(id)
    if (!job) throw new Error("Active recovery job missing")
    unwrapRight(await provider.requestUsageCacheRecovery(request)())
    expect(await queue.getActiveCount()).toBe(1)
    expect(await queue.getWaitingCount()).toBe(0)
    const completed = new Promise<void>(resolve => queue.once("completed", () => resolve()))
    release()
    await completed
    expect(await queue.getJob(id)).toBeNull()
    await queue.pause()
    unwrapRight(await provider.requestUsageCacheRecovery(request)())
    const next = await queue.getJob(id)
    if (!next) throw new Error("New recovery job missing")
    const finished = new Promise<void>(resolve => queue.once("completed", () => resolve()))
    await queue.resume()
    await finished
  }, 15000)

  it("defers settlement without consuming or resetting its remaining failure attempts", async () => {
    const settlements = module.get<Queue<TenantEventQueuePayload>>(getQueueToken(USAGE_SETTLEMENT_QUEUE))
    const event: TenantEventQueuePayload = {
      type: "usage.settlement",
      schemaVersion: 1,
      eventId: randomUUID(),
      organizationId: request.organizationId,
      operationId: uuidv7(),
      operationOcc: "1"
    }
    const job = await settlements.add(event.type, event, {jobId: event.eventId, attempts: 3})
    // Two ordinary failures have already occurred before this recovery deferral.
    job.attemptsMade = 2
    await module.get(UsageSettlementProcessor).apply(job)
    expect(job.attemptsMade).toBe(2)
    const delayed = await settlements.getDelayed()
    expect(delayed).toHaveLength(1)
    expect(delayed[0]?.opts).toMatchObject({attempts: 1, delay: 5000})
    expect(delayed[0]?.data).toEqual(event)
    await job.remove()
    await delayed[0]?.remove()
  })
})
