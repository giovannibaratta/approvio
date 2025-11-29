import {Injectable, Logger} from "@nestjs/common"
import {InjectQueue} from "@nestjs/bull"
import {Queue, JobOptions} from "bull"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {WORKFLOW_STATUS_CHANGED_QUEUE, WORKFLOW_STATUS_RECALCULATION_QUEUE} from "./queue.module"
import {EnqueueRecalculationError, QueueProvider} from "@services"
import {WorkflowStatusChangedEvent} from "@domain"

export interface RecalculationJobData {
  workflowId: string
}

const SHARED_QUEUE_OPTIONS: JobOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000
  },
  removeOnFail: {
    age: 604800 // Keep failed jobs for 7 days
  },
  removeOnComplete: true
}

@Injectable()
export class BullQueueProvider implements QueueProvider {
  constructor(
    @InjectQueue(WORKFLOW_STATUS_RECALCULATION_QUEUE)
    private readonly queue: Queue<RecalculationJobData>,
    @InjectQueue(WORKFLOW_STATUS_CHANGED_QUEUE)
    private readonly statusChangedQueue: Queue<WorkflowStatusChangedEvent>
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
            ...SHARED_QUEUE_OPTIONS
          }
        )
      },
      error => {
        Logger.error(`Failed to enqueue recalculation for workflow ${workflowId}`, error)
        return "unknown_error" as const
      }
    )
  }

  enqueueWorkflowStatusChanged(event: WorkflowStatusChangedEvent): TaskEither<EnqueueRecalculationError, void> {
    return TE.tryCatch(
      async () => {
        await this.statusChangedQueue.add("workflow-status-changed", event, SHARED_QUEUE_OPTIONS)
      },
      error => {
        Logger.error(`Failed to enqueue status change for workflow ${event.workflowId}`, error)
        return "unknown_error" as const
      }
    )
  }
}
