import {Inject} from "@nestjs/common"
import {EnqueueRecalculationError, QUEUE_PROVIDER_TOKEN, QueueProvider} from "./interface"
import {TaskEither} from "fp-ts/TaskEither"

export class QueueService {
  constructor(
    @Inject(QUEUE_PROVIDER_TOKEN)
    private readonly queueProvider: QueueProvider
  ) {}

  enqueueWorkflowStatusRecalculation(workflowId: string): TaskEither<EnqueueRecalculationError, void> {
    return this.queueProvider.enqueueWorkflowStatusRecalculation(workflowId)
  }
}
