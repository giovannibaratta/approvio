import {Inject} from "@nestjs/common"
import {
  EnqueueRecalculationError,
  EnqueueWorkflowActionEmailError,
  EnqueueWorkflowActionWebhookError,
  EnqueueWorkflowStatusChangedError,
  QUEUE_PROVIDER_TOKEN,
  QueueProvider
} from "./interface"
import {TaskEither} from "fp-ts/TaskEither"
import {WorkflowActionEmailEvent, WorkflowActionWebhookEvent, WorkflowStatusChangedEvent} from "@domain"

export class QueueService {
  constructor(
    @Inject(QUEUE_PROVIDER_TOKEN)
    private readonly queueProvider: QueueProvider
  ) {}

  enqueueWorkflowStatusRecalculation(workflowId: string): TaskEither<EnqueueRecalculationError, void> {
    return this.queueProvider.enqueueWorkflowStatusRecalculation(workflowId)
  }

  enqueueWorkflowStatusChanged(event: WorkflowStatusChangedEvent): TaskEither<EnqueueWorkflowStatusChangedError, void> {
    return this.queueProvider.enqueueWorkflowStatusChanged(event)
  }

  enqueueEmailAction(event: WorkflowActionEmailEvent): TaskEither<EnqueueWorkflowActionEmailError, void> {
    return this.queueProvider.enqueueEmailAction(event)
  }

  enqueueWebhookAction(event: WorkflowActionWebhookEvent): TaskEither<EnqueueWorkflowActionWebhookError, void> {
    return this.queueProvider.enqueueWebhookAction(event)
  }
}
