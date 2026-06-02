import {UnknownError} from "@services/error"
import {
  WorkflowStatusChangedEvent,
  WorkflowActionEmailEvent,
  WorkflowActionWebhookEvent,
  WorkflowActionSlackEvent
} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"

export type EnqueueRecalculationError = UnknownError
export type EnqueueWorkflowStatusChangedError = UnknownError
export type EnqueueWorkflowActionError = UnknownError
export type QueueHealthCheckFailed = "queue_health_check_failed"

export const QUEUE_PROVIDER_TOKEN = Symbol("QUEUE_PROVIDER_TOKEN")

export interface QueueProvider {
  /**
   * Enqueues a workflow recalculation job.
   * Uses workflowId as jobId for automatic deduplication.
   * @param workflowId The ID of the workflow to recalculate.
   * @returns A TaskEither with void or an enqueue error.
   */
  enqueueWorkflowStatusRecalculation(workflowId: string): TaskEither<EnqueueRecalculationError, void>

  /**
   * Bulk enqueues workflow recalculation jobs.
   * @param workflowIds Array of workflow IDs to recalculate.
   * @returns A TaskEither with void or an enqueue error.
   */
  enqueueWorkflowStatusRecalculationBulk(workflowIds: string[]): TaskEither<EnqueueRecalculationError, void>

  enqueueWorkflowStatusChanged(event: WorkflowStatusChangedEvent): TaskEither<EnqueueWorkflowStatusChangedError, void>
  enqueueWorkflowAction(
    event: WorkflowActionEmailEvent | WorkflowActionWebhookEvent | WorkflowActionSlackEvent
  ): TaskEither<EnqueueWorkflowActionError, void>
  /**
   * Checks the health of the queue provider.
   * @returns A TaskEither with void (healthy) or an UnknownError (unhealthy).
   */
  checkHealth(): TaskEither<QueueHealthCheckFailed, void>
}
