import {DispatchCompletion, DispatchOutcome} from "@services/durable-work/models"
import {Process, Processor} from "@nestjs/bull"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {Job} from "bull"
import {isLeft} from "fp-ts/Either"
import {TaskReadyEvent} from "@domain"
import {WORKFLOW_ACTION_WEBHOOK_QUEUE} from "@external"
import {TaskService} from "@services/task/task.service"
import {WebhookService} from "@services/webhook/webhook.service"
import {WORKER_ID} from "../worker.constants"

@Injectable()
@Processor(WORKFLOW_ACTION_WEBHOOK_QUEUE)
export class WorkflowActionWebhookProcessor {
  constructor(
    private readonly tasks: TaskService,
    private readonly webhook: WebhookService,
    @Inject(WORKER_ID) private readonly workerId: string
  ) {}

  @Process("task.ready")
  async handleWebhookAction(job: Pick<Job<TaskReadyEvent>, "data">): Promise<void> {
    const event = job.data
    if (event.type !== "task.ready" || event.taskKind !== "webhook")
      throw new Error("Expected a webhook task.ready event")

    const context = {organizationId: event.organizationId}
    await this.tasks.withDispatchLease(
      context,
      event.taskId,
      event.taskKind,
      this.workerId,
      async (claim, assertLease) => {
        const task = await this.tasks.getWebhookTask(context, event.taskId)()
        if (isLeft(task)) {
          const completion = await this.tasks.completeDispatch(
            context,
            claim.attemptId,
            claim.lease,
            {
              state: "failed",
              outcome: {type: "task_load_failed", error: task.left}
            },
            event.eventId
          )()
          if (isLeft(completion)) throw new Error(`Webhook pre-send failure recording failed: ${completion.left}`)
          throw new Error(`Webhook task load failed: ${task.left}`)
        }

        const executing = await this.tasks.startDispatchExecution(context, claim.attemptId, claim.lease)()
        if (isLeft(executing)) throw new Error(`Webhook dispatch lease lost: ${executing.left}`)
        if (executing.right === "parked") return

        await assertLease()
        const delivery = await this.webhook.executeWebhook(
          task.right.url,
          task.right.method,
          task.right.headers,
          task.right.payload,
          {
            idempotencyKey: event.taskId
          }
        )()
        const outcome: {state: DispatchCompletion["state"]; outcome: DispatchOutcome} = isLeft(delivery)
          ? {state: "unknown" as const, outcome: {type: "delivery_error", error: delivery.left}}
          : delivery.right.status >= 200 && delivery.right.status < 300
            ? {state: "succeeded" as const, outcome: {type: "http_response", statusCode: delivery.right.status}}
            : {state: "failed" as const, outcome: {type: "http_response", statusCode: delivery.right.status}}
        const completion = await this.tasks.completeDispatch(
          context,
          claim.attemptId,
          claim.lease,
          outcome,
          event.eventId
        )()
        if (isLeft(completion)) throw new Error(`Webhook completion failed: ${completion.left}`)
        if (isLeft(delivery)) throw new Error(`Webhook delivery outcome is unknown: ${delivery.left}`)

        Logger.log(`Webhook task ${event.taskId} dispatched`)
      }
    )
  }
}
