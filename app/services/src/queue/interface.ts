import {UnknownError} from "@services/error"
import {WorkflowStatusChangedEvent, WorkflowActionEmailEvent, WorkflowActionWebhookEvent} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"

export type EnqueueRecalculationError = UnknownError
export type EnqueueWorkflowStatusChangedError = UnknownError
export type EnqueueWorkflowActionEmailError = UnknownError
export type EnqueueWorkflowActionWebhookError = UnknownError

export const QUEUE_PROVIDER_TOKEN = Symbol("QUEUE_PROVIDER_TOKEN")

export interface QueueProvider {
  /**
   * Enqueues a workflow recalculation job.
   * Uses workflowId as jobId for automatic deduplication.
   * @param workflowId The ID of the workflow to recalculate.
   * @returns A TaskEither with void or an enqueue error.
   */
  enqueueWorkflowStatusRecalculation(workflowId: string): TaskEither<EnqueueRecalculationError, void>
  enqueueWorkflowStatusChanged(event: WorkflowStatusChangedEvent): TaskEither<EnqueueWorkflowStatusChangedError, void>
  enqueueEmailAction(event: WorkflowActionEmailEvent): TaskEither<EnqueueWorkflowActionEmailError, void>
  enqueueWebhookAction(event: WorkflowActionWebhookEvent): TaskEither<EnqueueWorkflowActionWebhookError, void>
}
