import {UnknownError} from "@services/error"
import {TaskEither} from "fp-ts/TaskEither"

export type EnqueueRecalculationError = UnknownError

export const QUEUE_PROVIDER_TOKEN = Symbol("QUEUE_PROVIDER_TOKEN")

export interface QueueProvider {
  /**
   * Enqueues a workflow recalculation job.
   * Uses workflowId as jobId for automatic deduplication.
   * @param workflowId The ID of the workflow to recalculate.
   * @returns A TaskEither with void or an enqueue error.
   */
  enqueueWorkflowStatusRecalculation(workflowId: string): TaskEither<EnqueueRecalculationError, void>
}
