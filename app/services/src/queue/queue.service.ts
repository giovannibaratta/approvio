import {Injectable, Inject} from "@nestjs/common"
import {TenantEvent} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {EnqueueTenantEventError, QUEUE_PROVIDER_TOKEN, QueueProvider} from "./interface"

/**
 * The queue is a transport for already-durable tenant events. Callers must
 * append an outbox record in their transaction before asking a relay to call
 * this service; it is not a business-operation side effect.
 */
@Injectable()
export class QueueService {
  constructor(
    @Inject(QUEUE_PROVIDER_TOKEN)
    private readonly queueProvider: QueueProvider
  ) {}

  enqueue(event: TenantEvent): TaskEither<EnqueueTenantEventError, void> {
    return this.queueProvider.enqueue(event)
  }
}
