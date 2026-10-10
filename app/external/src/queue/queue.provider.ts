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
  WORKFLOW_EXPIRATION_SWEEP_INTERVAL_MS,
  TENANT_OUTBOX_RELAY_QUEUE,
  USAGE_SETTLEMENT_QUEUE,
  USAGE_CACHE_RECOVERY_QUEUE
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
  // The discriminated TenantEvent union is the transport contract. route
  // narrows it by event type and task kind before selecting a Bull queue.
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
    private readonly sweepQueue: Queue<Record<string, never>>,
    @InjectQueue(TENANT_OUTBOX_RELAY_QUEUE)
    private readonly relayQueue: Queue<Record<string, never>>,
    @InjectQueue(USAGE_SETTLEMENT_QUEUE)
    private readonly usageQueue: Queue<TenantEventQueuePayload | Record<string, never>>,
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

  enqueue(event: TenantEvent, deliveryAttempt = 0): TaskEither<EnqueueTenantEventError, void> {
    if (event.type === "usage.settlement")
      return TE.tryCatch(
        async () => {
          await this.usageQueue.add(event.type, serializeTenantEvent(event), this.jobOptions(event, deliveryAttempt))
        },
        error => this.logEnqueueError(event, error)
      )

    const route = this.route(event)
    if (!route) return TE.left("unsupported_event")
    return TE.tryCatch(
      async () => {
        await route.queue.add(route.jobName, serializeTenantEvent(event), this.jobOptions(event, deliveryAttempt))
      },
      error => this.logEnqueueError(event, error)
    )
  }

  private jobOptions(event: TenantEvent, deliveryAttempt: number): JobOptions {
    return {
      ...SHARED_QUEUE_OPTIONS,
      jobId: `${event.organizationId}:${event.eventId}:${deliveryAttempt}`
    }
  }

  private logEnqueueError(event: TenantEvent, error: unknown): "unknown_error" {
    Logger.error(`Failed to enqueue tenant event ${event.type} for organization ${event.organizationId}`, error)
    return "unknown_error"
  }

  private route(
    event: Exclude<TenantEvent, {readonly type: "usage.settlement"}>
  ): {readonly queue: Queue<TenantEventQueuePayload>; readonly jobName: string} | undefined {
    switch (event.type) {
      case "workflow.recalculate":
        return {queue: this.queue, jobName: "recalculate-workflow"}
      case "workflow.status_changed":
        return {queue: this.statusChangedQueue, jobName: "workflow-status-changed"}
      case "task.ready":
        return {
          queue:
            event.taskKind === "email"
              ? this.emailActionQueue
              : event.taskKind === "webhook"
                ? this.webhookActionQueue
                : this.slackActionQueue,
          jobName: "task.ready"
        }
      case "organization.resumed":
        // No worker consumes this event yet; never send it to an unrelated queue.
        return undefined
    }
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
    try {
      const sweepIntervalMinutes = WORKFLOW_EXPIRATION_SWEEP_INTERVAL_MS / (60 * 1000)
      await this.registerRepeatable(this.sweepQueue, "sweep-expired-workflows", `*/${sweepIntervalMinutes} * * * *`, {})
      await this.registerRepeatable(this.relayQueue, "relay-tenant-outbox", "* * * * *", {})
      // Remove the old PostgreSQL usage scan when upgrading an existing queue.
      for (const job of await this.usageQueue.getRepeatableJobs())
        if (job.name === "reconcile-usage-settlements") await this.usageQueue.removeRepeatableByKey(job.key)
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

  private async registerRepeatable<T>(queue: Queue<T>, jobName: string, cron: string, data: T): Promise<void> {
    const repeatableJobs = await queue.getRepeatableJobs()
    for (const job of repeatableJobs)
      if (job.name === jobName && job.cron !== cron) {
        Logger.warn(`Removing obsolete repeatable job key ${job.key} (old cron: ${job.cron})`)
        await queue.removeRepeatableByKey(job.key)
      }

    await queue.add(jobName, data, {repeat: {cron}, jobId: jobName})
    Logger.log(`Registered repeatable job "${jobName}" with frequency "${cron}"`)
  }
}
