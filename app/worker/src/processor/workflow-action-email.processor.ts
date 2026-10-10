import {Process, Processor} from "@nestjs/bull"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {Job} from "bull"
import {isLeft} from "fp-ts/Either"
import {TaskReadyEvent} from "@domain"
import {WORKFLOW_ACTION_EMAIL_QUEUE} from "@external"
import {TaskService} from "@services/task/task.service"
import {EmailService} from "@services/email/email.service"
import {WORKER_ID} from "../worker.constants"

@Injectable()
@Processor(WORKFLOW_ACTION_EMAIL_QUEUE)
export class WorkflowActionEmailProcessor {
  constructor(
    private readonly tasks: TaskService,
    private readonly email: EmailService,
    @Inject(WORKER_ID) private readonly workerId: string
  ) {}

  @Process("task.ready")
  async handleEmailAction(job: Pick<Job<TaskReadyEvent>, "data">): Promise<void> {
    const event = job.data
    if (event.type !== "task.ready" || event.taskKind !== "email") throw new Error("Expected an email task.ready event")

    const context = {organizationId: event.organizationId}
    await this.tasks.withDispatchLease(
      context,
      event.taskId,
      event.taskKind,
      this.workerId,
      async (claim, assertLease) => {
        const task = await this.tasks.getEmailTask(context, event.taskId)()
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
          if (isLeft(completion)) throw new Error(`Email pre-send failure recording failed: ${completion.left}`)
          throw new Error(`Email task load failed: ${task.left}`)
        }

        const executing = await this.tasks.startDispatchExecution(context, claim.attemptId, claim.lease)()
        if (isLeft(executing)) throw new Error(`Email dispatch lease lost: ${executing.left}`)
        if (executing.right === "parked") return

        await assertLease()
        const delivery = await this.email.sendEmail({
          to: task.right.recipients,
          subject: task.right.subject,
          htmlBody: task.right.body
        })()
        const completion = await this.tasks.completeDispatch(
          context,
          claim.attemptId,
          claim.lease,
          {
            state: isLeft(delivery) ? "unknown" : "succeeded",
            outcome: isLeft(delivery) ? {type: "delivery_error", error: delivery.left} : {type: "delivered"}
          },
          event.eventId
        )()
        if (isLeft(completion)) throw new Error(`Email completion failed: ${completion.left}`)
        if (isLeft(delivery)) {
          Logger.error(`Email delivery outcome is unknown for task ${event.taskId}: ${delivery.left}`)
          return
        }

        Logger.log(`Email task ${event.taskId} dispatched`)
      }
    )
  }
}
