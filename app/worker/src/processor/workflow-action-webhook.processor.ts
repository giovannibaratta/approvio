import {Process, Processor} from "@nestjs/bull"
import {Job} from "bull"
import {Injectable, Logger, Inject} from "@nestjs/common"
import {WORKFLOW_ACTION_WEBHOOK_QUEUE} from "@external"
import {DispatchService} from "@services/durable-work/dispatch.service"
import {DispatchCompletion, DispatchOutcome} from "@services/durable-work/models"
import {DispatchClaim, WorkError} from "@services/durable-work/interfaces"
import {TaskGetErrorWebhookTask} from "@services/task/interfaces"
import {HttpError} from "@services/webhook/interfaces"
import {TaskService} from "@services/task/task.service"
import {WebhookService} from "@services/webhook/webhook.service"
import {WORKER_ID} from "../worker.constants"
import {TaskReadyEvent, DecoratedWorkflowActionWebhookTask} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {isLeft} from "fp-ts/Either"

@Injectable()
@Processor(WORKFLOW_ACTION_WEBHOOK_QUEUE)
export class WorkflowActionWebhookProcessor {
  constructor(
    private readonly taskService: TaskService,
    private readonly taskDispatch: DispatchService,
    private readonly webhookService: WebhookService,
    @Inject(WORKER_ID) private readonly workerId: string
  ) {}

  @Process("task.ready")
  async handleWebhookAction(job: Pick<Job<TaskReadyEvent>, "data">): Promise<void> {
    const event = job.data
    Logger.log(`Processing webhook action for task ${event.taskId}`)
    if (event.type !== "task.ready" || event.taskKind !== "webhook")
      throw new Error("Expected a webhook task.ready event")

    const context = {organizationId: event.organizationId}
    const processResult = await this.taskService.withDeliveryPermit(
      context,
      event.taskId,
      event.taskKind,
      this.workerId,
      (claim, validateOwnership) => this.processDispatch(event, claim, validateOwnership)
    )()
    // Bull retries rejected jobs; service failures stay in the Left until this boundary.
    if (isLeft(processResult)) {
      Logger.error(`Task processing failed: ${JSON.stringify(processResult.left)}`)
      throw new Error(String(processResult.left))
    }

    Logger.log(`Task processing completed successfully for task ${event.taskId}`)
  }

  private processDispatch(
    event: TaskReadyEvent,
    claim: DispatchClaim,
    validateOwnership: TE.TaskEither<WorkError, void>
  ): TE.TaskEither<WorkError | TaskGetErrorWebhookTask | HttpError, void> {
    return pipe(
      this.loadTask(event, claim),
      TE.chainW(task =>
        pipe(
          this.taskService.startDispatchExecution({organizationId: event.organizationId}, claim.attemptId, claim.lease),
          TE.chainW(() => validateOwnership),
          TE.chainW(() => this.executeWebhook(event, claim, task))
        )
      )
    )
  }

  private loadTask(
    event: TaskReadyEvent,
    claim: DispatchClaim
  ): TE.TaskEither<WorkError | TaskGetErrorWebhookTask, DecoratedWorkflowActionWebhookTask<{occ: true}>> {
    return pipe(
      this.taskService.getWebhookTask({organizationId: event.organizationId}, event.taskId),
      TE.tapError(error => this.completeDispatch(event, claim, "failed", {type: "task_load_failed", error}))
    )
  }

  private executeWebhook(
    event: TaskReadyEvent,
    claim: DispatchClaim,
    task: DecoratedWorkflowActionWebhookTask<{occ: true}>
  ): TE.TaskEither<WorkError | HttpError, void> {
    return pipe(
      this.webhookService.executeWebhook(task.url, task.method, task.headers, task.payload, {
        idempotencyKey: event.taskId
      }),
      TE.orElseW(error => TE.right(error)),
      TE.chainW(webhookResult => {
        if (typeof webhookResult === "string")
          return pipe(
            this.completeDispatch(event, claim, "unknown", {type: "delivery_error", error: webhookResult}),
            TE.chainW(() => TE.left(webhookResult))
          )

        return pipe(
          this.completeDispatch(
            event,
            claim,
            webhookResult.status >= 200 && webhookResult.status < 300 ? "succeeded" : "failed",
            {
              type: "http_response",
              statusCode: webhookResult.status
            }
          ),
          TE.map(() => Logger.log(`Webhook task ${event.taskId} dispatched`))
        )
      })
    )
  }

  private completeDispatch(
    event: TaskReadyEvent,
    claim: DispatchClaim,
    state: DispatchCompletion["state"],
    outcome: DispatchOutcome
  ): TE.TaskEither<WorkError, void> {
    return this.taskDispatch.complete(
      {organizationId: event.organizationId},
      claim.attemptId,
      claim.lease,
      {state, outcome},
      event.eventId
    )
  }
}
