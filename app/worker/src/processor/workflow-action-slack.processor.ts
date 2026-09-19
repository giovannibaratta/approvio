import {Process, Processor} from "@nestjs/bull"
import {Job} from "bull"
import {Injectable, Logger, Inject} from "@nestjs/common"
import {WORKFLOW_ACTION_SLACK_QUEUE} from "@external"
import {TaskService} from "@services"
import {SlackService} from "@services"
import {DispatchService} from "@services/durable-work/dispatch.service"
import {DispatchClaim, DispatchCompletion, DispatchOutcome, WorkError} from "@services/durable-work/interfaces"
import {TaskGetErrorSlackTask} from "@services/task/interfaces"
import {WORKER_ID} from "../worker.constants"
import {TaskReadyEvent, DecoratedWorkflowActionSlackTask} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {isLeft} from "fp-ts/Either"

@Injectable()
@Processor(WORKFLOW_ACTION_SLACK_QUEUE)
export class WorkflowActionSlackProcessor {
  constructor(
    private readonly taskService: TaskService,
    private readonly taskDispatch: DispatchService,
    private readonly slackService: SlackService,
    @Inject(WORKER_ID) private readonly workerId: string
  ) {}

  @Process("task.ready")
  async handleSlackAction(job: Pick<Job<TaskReadyEvent>, "data">): Promise<void> {
    const event = job.data
    Logger.log(`Processing slack action for task ${event.taskId}`)
    if (event.type !== "task.ready" || event.taskKind !== "slack") throw new Error("Expected a Slack task.ready event")

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
  ): TE.TaskEither<WorkError | TaskGetErrorSlackTask, void> {
    return pipe(
      this.loadTask(event, claim),
      TE.chainW(task =>
        pipe(
          this.taskService.startDispatchExecution({organizationId: event.organizationId}, claim.attemptId, claim.lease),
          TE.chainW(() => validateOwnership),
          TE.chainW(() => this.sendSlack(event, claim, task))
        )
      )
    )
  }

  private loadTask(
    event: TaskReadyEvent,
    claim: DispatchClaim
  ): TE.TaskEither<WorkError | TaskGetErrorSlackTask, DecoratedWorkflowActionSlackTask<{occ: true}>> {
    return pipe(
      this.taskService.getSlackTask({organizationId: event.organizationId}, event.taskId),
      TE.tapError(error => this.completeDispatch(event, claim, "failed", {type: "task_load_failed", error}))
    )
  }

  private sendSlack(
    event: TaskReadyEvent,
    claim: DispatchClaim,
    task: DecoratedWorkflowActionSlackTask<{occ: true}>
  ): TE.TaskEither<WorkError, void> {
    return pipe(
      this.slackService.sendNotification({webhookUrl: task.webhookUrl, text: task.message || ""}),
      TE.map(() => undefined),
      TE.orElseW(error => TE.right(error)),
      TE.chainW(slackResult =>
        pipe(
          this.completeDispatch(
            event,
            claim,
            typeof slackResult === "string" ? "unknown" : "succeeded",
            typeof slackResult === "string" ? {type: "delivery_error", error: slackResult} : {type: "delivered"}
          ),
          TE.map(() => {
            if (typeof slackResult === "string")
              Logger.error(`Slack delivery outcome is unknown for task ${event.taskId}: ${slackResult}`)
            else Logger.log(`Slack task ${event.taskId} dispatched`)
          })
        )
      )
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
