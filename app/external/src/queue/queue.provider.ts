import {Injectable, Logger, OnModuleDestroy} from "@nestjs/common"
import {InjectQueue} from "@nestjs/bull"
import {Queue, JobOptions} from "bull"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {
  WORKFLOW_STATUS_CHANGED_QUEUE,
  WORKFLOW_STATUS_RECALCULATION_QUEUE,
  WORKFLOW_ACTION_EMAIL_QUEUE,
  WORKFLOW_ACTION_WEBHOOK_QUEUE
} from "./queue.module"
import {
  EnqueueRecalculationError,
  EnqueueWorkflowActionEmailError,
  EnqueueWorkflowActionWebhookError,
  EnqueueWorkflowStatusChangedError,
  QueueHealthCheckFailed,
  QueueProvider
} from "@services"
import {WorkflowStatusChangedEvent, WorkflowActionEmailEvent, WorkflowActionWebhookEvent} from "@domain"

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
  removeOnComplete: {
    age: 604800 // Keep completed jobs for 7 days to make the job deduplication work correctly
  }
}

@Injectable()
export class BullQueueProvider implements QueueProvider, OnModuleDestroy {
  constructor(
    @InjectQueue(WORKFLOW_STATUS_RECALCULATION_QUEUE)
    private readonly queue: Queue<RecalculationJobData>,
    @InjectQueue(WORKFLOW_STATUS_CHANGED_QUEUE)
    private readonly statusChangedQueue: Queue<WorkflowStatusChangedEvent>,
    @InjectQueue(WORKFLOW_ACTION_EMAIL_QUEUE)
    private readonly emailActionQueue: Queue<WorkflowActionEmailEvent>,
    @InjectQueue(WORKFLOW_ACTION_WEBHOOK_QUEUE)
    private readonly webhookActionQueue: Queue<WorkflowActionWebhookEvent>
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

  enqueueWorkflowStatusChanged(event: WorkflowStatusChangedEvent): TaskEither<EnqueueWorkflowStatusChangedError, void> {
    return TE.tryCatch(
      async () => {
        await this.statusChangedQueue.add("workflow-status-changed", event, {
          ...SHARED_QUEUE_OPTIONS,
          jobId: event.eventId
        })
      },
      error => {
        Logger.error(`Failed to enqueue status change for workflow ${event.workflowId}`, error)
        return "unknown_error" as const
      }
    )
  }

  enqueueEmailAction(event: WorkflowActionEmailEvent): TaskEither<EnqueueWorkflowActionEmailError, void> {
    return TE.tryCatch(
      async () => {
        await this.emailActionQueue.add("workflow-action-email", event, {
          ...SHARED_QUEUE_OPTIONS,
          jobId: event.taskId
        })
      },
      error => {
        Logger.error(`Failed to enqueue email action for task ${event.taskId}`, error)
        return "unknown_error" as const
      }
    )
  }

  enqueueWebhookAction(event: WorkflowActionWebhookEvent): TaskEither<EnqueueWorkflowActionWebhookError, void> {
    return TE.tryCatch(
      async () => {
        await this.webhookActionQueue.add("workflow-action-webhook", event, {
          ...SHARED_QUEUE_OPTIONS,
          jobId: event.taskId
        })
      },
      error => {
        Logger.error(`Failed to enqueue webhook action for task ${event.taskId}`, error)
        return "unknown_error" as const
      }
    )
  }

  checkHealth(): TaskEither<QueueHealthCheckFailed, void> {
    return TE.tryCatch(
      async () => {
        // The ping function does not throw an error when the connection is not available, it just
        // block the execution. The timeout is needed to return without waiting for the ping
        // response.
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Redis ping timeout")), 2000))
        await Promise.race([this.queue.client.ping(), timeout])
      },
      error => {
        Logger.error("Failed to check redis connection", error)
        return "queue_health_check_failed" as const
      }
    )
  }
  async onModuleDestroy() {
    await Promise.all([
      this.queue.close(),
      this.statusChangedQueue.close(),
      this.emailActionQueue.close(),
      this.webhookActionQueue.close()
    ])
  }
}
