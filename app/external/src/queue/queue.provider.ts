import {Injectable, Logger, OnModuleDestroy, OnModuleInit} from "@nestjs/common"
import {InjectQueue} from "@nestjs/bull"
import {Queue, JobOptions} from "bull"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {
  WORKFLOW_STATUS_CHANGED_QUEUE,
  WORKFLOW_STATUS_RECALCULATION_QUEUE,
  WORKFLOW_ACTION_EMAIL_QUEUE,
  WORKFLOW_ACTION_WEBHOOK_QUEUE,
  WORKFLOW_ACTION_SLACK_QUEUE,
  WORKFLOW_EXPIRATION_SWEEP_QUEUE
} from "./queue.module"
import {
  EnqueueRecalculationError,
  EnqueueWorkflowActionError,
  EnqueueWorkflowStatusChangedError,
  QueueHealthCheckFailed,
  QueueProvider
} from "@services"
import {
  WorkflowStatusChangedEvent,
  WorkflowActionEmailEvent,
  WorkflowActionWebhookEvent,
  WorkflowActionSlackEvent,
  WorkflowActionType
} from "@domain"

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
export class BullQueueProvider implements QueueProvider, OnModuleDestroy, OnModuleInit {
  constructor(
    @InjectQueue(WORKFLOW_STATUS_RECALCULATION_QUEUE)
    private readonly queue: Queue<RecalculationJobData>,
    @InjectQueue(WORKFLOW_STATUS_CHANGED_QUEUE)
    private readonly statusChangedQueue: Queue<WorkflowStatusChangedEvent>,
    @InjectQueue(WORKFLOW_ACTION_EMAIL_QUEUE)
    private readonly emailActionQueue: Queue<WorkflowActionEmailEvent>,
    @InjectQueue(WORKFLOW_ACTION_WEBHOOK_QUEUE)
    private readonly webhookActionQueue: Queue<WorkflowActionWebhookEvent>,
    @InjectQueue(WORKFLOW_ACTION_SLACK_QUEUE)
    private readonly slackActionQueue: Queue<WorkflowActionSlackEvent>,
    @InjectQueue(WORKFLOW_EXPIRATION_SWEEP_QUEUE)
    private readonly sweepQueue: Queue<Record<string, never>>
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

  enqueueWorkflowStatusRecalculationBulk(workflowIds: string[]): TaskEither<EnqueueRecalculationError, void> {
    return TE.tryCatch(
      async () => {
        if (workflowIds.length === 0) return
        const jobs = workflowIds.map(id => ({
          name: "recalculate-workflow",
          data: {workflowId: id},
          opts: {
            jobId: id, // Retains automatic deduplication per workflow ID!
            ...SHARED_QUEUE_OPTIONS
          }
        }))
        await this.queue.addBulk(jobs)
      },
      error => {
        Logger.error(`Failed to bulk enqueue recalculation jobs for ${workflowIds.length} workflows`, error)
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

  enqueueWorkflowAction(
    event: WorkflowActionEmailEvent | WorkflowActionWebhookEvent | WorkflowActionSlackEvent
  ): TaskEither<EnqueueWorkflowActionError, void> {
    return TE.tryCatch(
      async () => {
        const payload = {
          ...SHARED_QUEUE_OPTIONS,
          jobId: event.taskId
        }

        switch (event.type) {
          case WorkflowActionType.EMAIL:
            await this.emailActionQueue.add("workflow-action-email", event, payload)
            break
          case WorkflowActionType.WEBHOOK:
            await this.webhookActionQueue.add("workflow-action-webhook", event, payload)
            break
          case WorkflowActionType.SLACK:
            await this.slackActionQueue.add("workflow-action-slack", event, payload)
            break
        }
      },
      error => {
        Logger.error(`Failed to enqueue action ${event.type} for task ${event.taskId}`, error)
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

  async onModuleInit() {
    const targetCron = "*/5 * * * *"
    const jobName = "sweep-expired-workflows"

    try {
      // 1. Get all registered repeatable jobs in the sweep queue
      const repeatableJobs = await this.sweepQueue.getRepeatableJobs()

      // 2. Clean up any obsolete repeatable jobs with different cron frequencies
      for (const job of repeatableJobs) {
        if (job.name === jobName && job.cron !== targetCron) {
          Logger.warn(`Removing obsolete repeatable job key ${job.key} (old cron: ${job.cron})`)
          await this.sweepQueue.removeRepeatableByKey(job.key)
        }
      }

      // 3. Add/update the repeatable job with the target frequency on the sweep queue
      await this.sweepQueue.add(
        jobName,
        {},
        {
          repeat: {cron: targetCron},
          jobId: jobName // Deduplication key
        }
      )
      Logger.log(`Successfully registered repeatable job "${jobName}" with frequency "${targetCron}" on sweep queue`)
    } catch (error) {
      Logger.error(`Failed to manage repeatable job "${jobName}"`, error)
      throw error
    }
  }

  async onModuleDestroy() {
    await Promise.all([
      this.queue.close(),
      this.statusChangedQueue.close(),
      this.emailActionQueue.close(),
      this.webhookActionQueue.close(),
      this.slackActionQueue.close(),
      this.sweepQueue.close()
    ])
  }
}
