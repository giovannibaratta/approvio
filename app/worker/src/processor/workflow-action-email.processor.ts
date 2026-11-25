import {Process, Processor} from "@nestjs/bull"
import {Job} from "bull"
import {Injectable, Logger, Inject} from "@nestjs/common"
import {WORKFLOW_ACTION_EMAIL_QUEUE} from "@external"
import {DispatchService} from "@services/durable-work/dispatch.service"
import {DispatchClaim, DispatchCompletion, DispatchOutcome, WorkError} from "@services/durable-work/interfaces"
import {TaskGetErrorEmailTask} from "@services/task/interfaces"
import {TaskService} from "@services/task/task.service"
import {EmailService} from "@services/email/email.service"
import {WORKER_ID} from "../worker.constants"
import {TaskReadyEvent, TenantEventFactory, DecoratedWorkflowActionEmailTask} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"

@Injectable()
@Processor(WORKFLOW_ACTION_EMAIL_QUEUE)
export class WorkflowActionEmailProcessor {
  constructor(
    private readonly taskService: TaskService,
    private readonly taskDispatch: DispatchService,
    private readonly emailService: EmailService,
    @Inject(WORKER_ID) private readonly workerId: string
  ) {}

  @Process("task.ready")
  async handleEmailAction(job: Pick<Job<unknown>, "data">): Promise<void> {
    const processResult = await pipe(
      TenantEventFactory.validate(job.data),
      E.mapLeft(error => `Invalid task-ready event: ${error}`),
      E.chainW(event => {
        if (event.type !== "task.ready" || event.taskKind !== "email")
          return E.left("Expected an email task.ready event")
        return E.right(event)
      }),
      TE.fromEither,
      TE.chainFirstIOK(event => () => Logger.log(`Processing email action for task ${event.taskId}`)),
      TE.chainFirstW(event => this.taskDispatch.validateEvent(event)),
      TE.chainFirstW(event =>
        this.taskService.withDeliveryPermit(
          {organizationId: event.organizationId},
          event.taskId,
          event.taskKind,
          this.workerId,
          (claim, validateOwnership) => this.processDispatch(event, claim, validateOwnership)
        )
      )
    )()
    // Bull retries rejected jobs; service failures stay in the Left until this boundary.
    if (E.isLeft(processResult)) {
      Logger.error(`Task processing failed: ${JSON.stringify(processResult.left)}`)
      throw new Error(typeof processResult.left === "string" ? processResult.left : processResult.left.code)
    }

    Logger.log(`Task processing completed successfully for task ${processResult.right.taskId}`)
  }

  private processDispatch(
    event: TaskReadyEvent,
    claim: DispatchClaim,
    validateOwnership: TE.TaskEither<WorkError, void>
  ): TE.TaskEither<WorkError | TaskGetErrorEmailTask, void> {
    return pipe(
      this.loadTask(event, claim),
      TE.chainW(task =>
        pipe(
          this.taskService.startDispatchExecution({organizationId: event.organizationId}, claim.attemptId, claim.lease),
          TE.chainW(() => validateOwnership),
          TE.chainW(() => this.sendEmail(event, claim, task))
        )
      )
    )
  }

  private loadTask(
    event: TaskReadyEvent,
    claim: DispatchClaim
  ): TE.TaskEither<WorkError | TaskGetErrorEmailTask, DecoratedWorkflowActionEmailTask<{occ: true}>> {
    return pipe(
      this.taskService.getEmailTask({organizationId: event.organizationId}, event.taskId),
      TE.tapError(error => this.completeDispatch(event, claim, "failed", {type: "task_load_failed", error}))
    )
  }

  private sendEmail(
    event: TaskReadyEvent,
    claim: DispatchClaim,
    task: DecoratedWorkflowActionEmailTask<{occ: true}>
  ): TE.TaskEither<WorkError, void> {
    return pipe(
      this.emailService.sendEmail({to: task.recipients, subject: task.subject, htmlBody: task.body}),
      TE.map(() => undefined),
      TE.orElseW(error => TE.right(error)),
      TE.chainW(emailResult =>
        pipe(
          this.completeDispatch(
            event,
            claim,
            typeof emailResult === "string" ? "unknown" : "succeeded",
            typeof emailResult === "string" ? {type: "delivery_error", error: emailResult} : {type: "delivered"}
          ),
          TE.map(() => {
            if (typeof emailResult === "string")
              Logger.error(`Email delivery outcome is unknown for task ${event.taskId}: ${emailResult}`)
            else Logger.log(`Email task ${event.taskId} dispatched`)
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
