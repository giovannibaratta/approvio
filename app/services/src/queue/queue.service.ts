import {Inject} from "@nestjs/common"
import {
  EnqueueRecalculationError,
  EnqueueWorkflowActionError,
  EnqueueWorkflowStatusChangedError,
  QUEUE_PROVIDER_TOKEN,
  QueueProvider
} from "./interface"
import {TaskEither} from "fp-ts/TaskEither"
import {
  WorkflowActionEmailEvent,
  WorkflowActionWebhookEvent,
  WorkflowActionSlackEvent,
  WorkflowStatusChangedEvent
} from "@domain"

export class QueueService {
  constructor(
    @Inject(QUEUE_PROVIDER_TOKEN)
    private readonly queueProvider: QueueProvider
  ) {}

  enqueueWorkflowStatusRecalculation(workflowId: string): TaskEither<EnqueueRecalculationError, void> {
    return this.queueProvider.enqueueWorkflowStatusRecalculation(workflowId)
  }

  enqueueWorkflowStatusRecalculationBulk(workflowIds: string[]): TaskEither<EnqueueRecalculationError, void> {
    return this.queueProvider.enqueueWorkflowStatusRecalculationBulk(workflowIds)
  }

  enqueueWorkflowStatusChanged(event: WorkflowStatusChangedEvent): TaskEither<EnqueueWorkflowStatusChangedError, void> {
    return this.queueProvider.enqueueWorkflowStatusChanged(event)
  }

  enqueueWorkflowAction(
    event: WorkflowActionEmailEvent | WorkflowActionWebhookEvent | WorkflowActionSlackEvent
  ): TaskEither<EnqueueWorkflowActionError, void> {
    return this.queueProvider.enqueueWorkflowAction(event)
  }
}
