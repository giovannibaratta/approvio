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
  WORKFLOW_EXPIRATION_SWEEP_QUEUE,
  TENANT_OUTBOX_RELAY_QUEUE,
  USAGE_SETTLEMENT_QUEUE,
  USAGE_CACHE_RECOVERY_QUEUE,
  WorkflowExpirationSweepJobData,
  ScheduledScanJobData
} from "./queue.module"
import {EnqueueTenantEventError, QueueHealthCheckFailed, QueueProvider} from "@services"
import {TenantEvent} from "@domain"
import {serializeTenantEvent, TenantEventQueuePayload} from "./tenant-event-payload"
import {UsageCacheRecoveryRequest} from "@services/usage-metering"

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
    private readonly queue: Queue<TenantEventQueuePayload>,
    @InjectQueue(WORKFLOW_STATUS_CHANGED_QUEUE)
    private readonly statusChangedQueue: Queue<TenantEventQueuePayload>,
    @InjectQueue(WORKFLOW_ACTION_EMAIL_QUEUE)
    private readonly emailActionQueue: Queue<TenantEventQueuePayload>,
    @InjectQueue(WORKFLOW_ACTION_WEBHOOK_QUEUE)
    private readonly webhookActionQueue: Queue<TenantEventQueuePayload>,
    @InjectQueue(WORKFLOW_ACTION_SLACK_QUEUE)
    private readonly slackActionQueue: Queue<TenantEventQueuePayload>,
    @InjectQueue(WORKFLOW_EXPIRATION_SWEEP_QUEUE)
    private readonly sweepQueue: Queue<WorkflowExpirationSweepJobData>,
    @InjectQueue(TENANT_OUTBOX_RELAY_QUEUE)
    private readonly relayQueue: Queue<ScheduledScanJobData>,
    @InjectQueue(USAGE_SETTLEMENT_QUEUE)
    private readonly usageQueue: Queue<TenantEventQueuePayload>,
    @InjectQueue(USAGE_CACHE_RECOVERY_QUEUE)
    private readonly recoveryQueue: Queue<UsageCacheRecoveryRequest>
  ) {}

  requestUsageCacheRecovery(request: UsageCacheRecoveryRequest): TaskEither<"unknown_error", void> {
    return TE.tryCatch(
      async () => {
        // Bull deduplicates this ID across waiting, delayed and active jobs. Removal on
        // completion/failure lets a later cache loss request recovery of the same key.
        await this.recoveryQueue.add("rebuild-usage-cache", request, {
          ...SHARED_QUEUE_OPTIONS,
          jobId: `${request.organizationId}:${request.metric}:${request.period}`,
          priority: 1,
          attempts: 10,
          removeOnComplete: true,
          removeOnFail: true
        })
      },
      error => {
        Logger.error(`Failed to request usage cache recovery for ${request.organizationId}`, error)
        return "unknown_error" as const
      }
    )
  }

  enqueue(event: TenantEvent, deliveryAttempt = 0n): TaskEither<EnqueueTenantEventError, void> {
    return TE.tryCatch(
      async () => {
        const payload = {
          ...SHARED_QUEUE_OPTIONS,
          jobId: `${event.organizationId}:${event.eventId}:${deliveryAttempt}`
        }
        const data = serializeTenantEvent(event)

        switch (event.type) {
          case "workflow.recalculate":
            await this.queue.add("recalculate-workflow", data, payload)
            break
          case "workflow.status_changed":
            await this.statusChangedQueue.add("workflow-status-changed", data, payload)
            break
          case "usage.settlement":
            await this.usageQueue.add(event.type, data, payload)
            break
          case "task.ready":
            switch (event.taskKind) {
              case "email":
                await this.emailActionQueue.add("task.ready", data, payload)
                break
              case "webhook":
                await this.webhookActionQueue.add("task.ready", data, payload)
                break
              case "slack":
                await this.slackActionQueue.add("task.ready", data, payload)
                break
            }
            break
        }
      },
      error => {
        Logger.error(`Failed to enqueue tenant event ${event.type} for organization ${event.organizationId}`, error)
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
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Redis ping timeout")), 500))
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
      for (const job of repeatableJobs)
        if (job.name === jobName && job.cron !== targetCron) {
          Logger.warn(`Removing obsolete repeatable job key ${job.key} (old cron: ${job.cron})`)
          await this.sweepQueue.removeRepeatableByKey(job.key)
        }

      // 3. Add/update the repeatable job with the target frequency on the sweep queue
      await this.sweepQueue.add(jobName, undefined, {
        repeat: {cron: targetCron},
        jobId: jobName // Deduplication key
      })
      Logger.log(`Successfully registered repeatable job "${jobName}" with frequency "${targetCron}" on sweep queue`)

      const relayJobName = "relay-tenant-outbox"
      const relayCron = "* * * * *"

      for (const job of await this.relayQueue.getRepeatableJobs())
        if (job.name === relayJobName && job.cron !== relayCron) {
          Logger.warn(`Removing obsolete repeatable job key ${job.key} (old cron: ${job.cron})`)
          await this.relayQueue.removeRepeatableByKey(job.key)
        }

      await this.relayQueue.add(relayJobName, undefined, {repeat: {cron: relayCron}, jobId: relayJobName})
    } catch (error) {
      Logger.error("Failed to manage repeatable worker jobs", error)
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
      this.sweepQueue.close(),
      this.relayQueue.close(),
      this.usageQueue.close(),
      this.recoveryQueue.close()
    ])
  }
}
