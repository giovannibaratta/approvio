import {Injectable, Inject} from "@nestjs/common"
import {TenantEvent} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {EnqueueTenantEventError, QUEUE_PROVIDER_TOKEN, QueueProvider} from "./interface"
import {UsageCacheRecoveryRequest} from "../usage-metering/interfaces"
import {UnknownError} from "../error"

/** Sends tenant events to the configured queue provider. */
@Injectable()
export class QueueService {
  constructor(
    @Inject(QUEUE_PROVIDER_TOKEN)
    private readonly queueProvider: QueueProvider
  ) {}

  enqueue(event: TenantEvent, deliveryAttempt?: number): TaskEither<EnqueueTenantEventError, void> {
    return this.queueProvider.enqueue(event, deliveryAttempt)
  }

  requestUsageCacheRecovery(request: UsageCacheRecoveryRequest): TaskEither<UnknownError, void> {
    return this.queueProvider.requestUsageCacheRecovery(request)
  }
}
