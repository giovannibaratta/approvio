import {Process, Processor} from "@nestjs/bull"
import {Job} from "bull"
import {UsageMeteringService} from "@services/usage-metering"
import {isLeft} from "fp-ts/Either"
import {USAGE_SETTLEMENT_QUEUE} from "@external"
import {TenantEventQueuePayload} from "@external/queue/tenant-event-payload"
import {isUUIDv7} from "@utils"
import {v7 as uuidv7} from "uuid"

@Processor(USAGE_SETTLEMENT_QUEUE)
export class UsageSettlementProcessor {
  constructor(private readonly metering: UsageMeteringService) {}

  @Process("usage.settlement")
  async apply(job: Job<TenantEventQueuePayload>): Promise<void> {
    const event = job.data
    if (
      event.type !== "usage.settlement" ||
      event.schemaVersion !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.eventId) ||
      !isUUIDv7(event.organizationId) ||
      !isUUIDv7(event.operationId) ||
      !/^[1-9]\d*$/.test(event.operationOcc)
    )
      throw new Error("Invalid usage.settlement event")

    const result = await this.metering.applySettlement(
      {organizationId: event.organizationId},
      event.operationId,
      event.operationOcc
    )()
    if (isLeft(result)) {
      if (result.left === "quota_cache_unavailable") {
        // Defer without consuming execution-failure attempts. Recovery jobs have
        // their own queue, so deferred settlements cannot starve their rebuilder.
        await job.queue.add(job.name, job.data, {
          ...job.opts,
          attempts: Math.max(1, (job.opts.attempts ?? 1) - job.attemptsMade),
          jobId: `${event.organizationId}:${event.eventId}:recovery:${uuidv7()}`,
          delay: 5000
        })
        return
      }
      throw new Error(`Usage settlement failed: ${typeof result.left === "string" ? result.left : result.left.type}`, {
        cause: result.left
      })
    }
  }
}
