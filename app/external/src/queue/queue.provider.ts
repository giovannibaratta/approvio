import {Injectable, Logger} from "@nestjs/common"
import {InjectQueue} from "@nestjs/bull"
import {Queue} from "bull"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {WORKFLOW_STATUS_RECALCULATION_QUEUE} from "./queue.module"
import {EnqueueRecalculationError, QueueProvider} from "@services"

export interface RecalculationJobData {
  workflowId: string
}

@Injectable()
export class BullQueueProvider implements QueueProvider {
  constructor(
    @InjectQueue(WORKFLOW_STATUS_RECALCULATION_QUEUE)
    private readonly queue: Queue<RecalculationJobData>
  ) {}

  /**
   * Enqueues a workflow recalculation job.
   * Uses workflowId as jobId for automatic deduplication.
   */
  enqueueWorkflowStatusRecalculation(workflowId: string): TaskEither<EnqueueRecalculationError, void> {
    return TE.tryCatch(
      async () => {
        await this.queue.add(
          "recalculate-workflow",
          {workflowId},
          {
            jobId: workflowId, // Automatic deduplication
            attempts: 3,
            backoff: {
              type: "exponential",
              delay: 2000 // 2s, 4s, 8s
            },
            removeOnFail: {
              age: 604800 // Keep failed jobs for 7 days
            }
          }
        )
      },
      error => {
        Logger.error(`Failed to enqueue recalculation for workflow ${workflowId}`, error)
        return "unknown_error" as const
      }
    )
  }
}
