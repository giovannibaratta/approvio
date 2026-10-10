import {Process, Processor} from "@nestjs/bull"
import {Job} from "bull"
import {isOrganizationId, isUsageMetric} from "@domain"
import {USAGE_CACHE_RECOVERY_QUEUE} from "@external"
import {UsageCacheRecoveryRequest, UsageMeteringService} from "@services/usage-metering"
import {isLeft} from "fp-ts/Either"

/** Rebuilds one quota key from durable facts before admission can resume. */
@Processor(USAGE_CACHE_RECOVERY_QUEUE)
export class UsageCacheRecoveryProcessor {
  constructor(private readonly metering: UsageMeteringService) {}

  @Process({name: "rebuild-usage-cache", concurrency: 2})
  async rebuild(job: Pick<Job<UsageCacheRecoveryRequest>, "data">): Promise<void> {
    const {organizationId, metric, period} = job.data
    if (!isOrganizationId(organizationId) || !isUsageMetric(metric) || typeof period !== "string")
      throw new Error("Invalid usage cache recovery request")

    const result = await this.metering.rebuildUsageCache({organizationId}, metric, period)()
    if (isLeft(result))
      throw new Error(
        `Usage cache recovery failed: ${typeof result.left === "string" ? result.left : result.left.type}`,
        {cause: result.left}
      )
  }
}
