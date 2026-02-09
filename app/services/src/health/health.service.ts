import {Inject, Injectable} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {DbHealthCheckFailed, HEALTH_REPOSITORY_TOKEN, HealthRepository} from "./health.repository"
import {QUEUE_PROVIDER_TOKEN, QueueHealthCheckFailed, QueueProvider} from "../queue"

@Injectable()
export class HealthService {
  constructor(
    @Inject(HEALTH_REPOSITORY_TOKEN) private readonly healthRepository: HealthRepository,
    @Inject(QUEUE_PROVIDER_TOKEN) private readonly queueProvider: QueueProvider
  ) {}

  checkHealth(): TE.TaskEither<DbHealthCheckFailed | QueueHealthCheckFailed, void> {
    return pipe(
      [this.healthRepository.checkDatabaseConnection(), this.queueProvider.checkHealth()],
      TE.sequenceArray,
      TE.map(() => undefined)
    )
  }
}
