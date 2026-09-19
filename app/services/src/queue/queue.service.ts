import {Injectable, Inject} from "@nestjs/common"
import {TenantEvent} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {EnqueueTenantEventError, QUEUE_PROVIDER_TOKEN, QueueProvider} from "./interface"

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
}
