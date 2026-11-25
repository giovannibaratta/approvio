import {getQueueToken} from "@nestjs/bull"
import {Test, TestingModule} from "@nestjs/testing"
import {Queue} from "bull"
import {ConfigModule, QueueModule} from "@external"
import {ConfigProvider} from "@external/config"
import {USAGE_SETTLEMENT_QUEUE} from "@external/queue/queue.module"
import {TenantEventQueuePayload} from "@external/queue/tenant-event-payload"
import {UsageMeteringError, UsageMeteringService} from "@services/usage-metering"
import {MockConfigProvider} from "@test/mock-data"
import {cleanRedisByPrefix, prepareRedisPrefix} from "@test/database"
import {randomOrgId} from "@test/organization-id"
import * as TE from "fp-ts/TaskEither"
import {v7 as uuidv7} from "uuid"
import {randomUUID} from "crypto"
import {UsageSettlementProcessor} from "../../src/processor/usage-settlement.processor"

describe("UsageSettlementProcessor Integration", () => {
  let module: TestingModule
  const prefix = prepareRedisPrefix()

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule, QueueModule],
      providers: [
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
  })

  afterAll(async () => {
    await module.close()
    await cleanRedisByPrefix(prefix)
  })

  it("defers settlement without consuming or resetting its remaining failure attempts", async () => {
    // Given
    const settlements = module.get<Queue<TenantEventQueuePayload>>(getQueueToken(USAGE_SETTLEMENT_QUEUE))
    const event: TenantEventQueuePayload = {
      type: "usage.settlement",
      schemaVersion: 1,
      eventId: randomUUID(),
      organizationId: randomOrgId(),
      operationId: uuidv7()
    }
    const job = await settlements.add(event.type, event, {jobId: event.eventId, attempts: 3})
    // Two ordinary failures have already occurred before this recovery deferral.
    job.attemptsMade = 2

    // When
    await module.get(UsageSettlementProcessor).apply(job)

    // Expect
    expect(job.attemptsMade).toBe(2)
    const delayed = await settlements.getDelayed()
    expect(delayed).toHaveLength(1)
    expect(delayed[0]?.opts).toMatchObject({attempts: 1, delay: 5000})
    expect(delayed[0]?.data).toEqual(event)
  })
})
