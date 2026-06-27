import {Inject, Injectable, Logger} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {DbHealthCheckFailed, HEALTH_REPOSITORY_TOKEN, HealthRepository} from "./health.repository"
import {QUEUE_PROVIDER_TOKEN, QueueHealthCheckFailed, QueueProvider} from "../queue"
import {ConfigProvider} from "@external/config"
import {Either, right, left} from "fp-ts/Either"

@Injectable()
export class HealthService {
  private cachedHealthResult?: Either<DbHealthCheckFailed | QueueHealthCheckFailed, void>
  private cacheTimestampMs = 0
  private readonly healthCacheTtlMs: number

  constructor(
    @Inject(HEALTH_REPOSITORY_TOKEN) private readonly healthRepository: HealthRepository,
    @Inject(QUEUE_PROVIDER_TOKEN) private readonly queueProvider: QueueProvider,
    private readonly configProvider: ConfigProvider
  ) {
    this.healthCacheTtlMs = configProvider.healthCacheTtlMs ?? 1000
  }

  checkHealth(): TE.TaskEither<DbHealthCheckFailed | QueueHealthCheckFailed, void> {
    const now = Date.now()
    if (this.cachedHealthResult && now - this.cacheTimestampMs < this.healthCacheTtlMs){
      Logger.log("Returning cached health result", "HealthService")
      return TE.fromEither(this.cachedHealthResult)
    }

    Logger.log("Running health check", "HealthService")

    return pipe(
      [this.healthRepository.checkDatabaseConnection(), this.queueProvider.checkHealth()],
      TE.sequenceArray,
      TE.map(() => undefined),
      TE.map(result => {
        this.cachedHealthResult = right(result)
        this.cacheTimestampMs = Date.now()
        return result
      }),
      TE.mapLeft(error => {
        this.cachedHealthResult = left(error)
        this.cacheTimestampMs = Date.now()
        return error
      })
    )
  }
}
