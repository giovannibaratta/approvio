import {Process, Processor} from "@nestjs/bull"
import {Job} from "bull"
import {Injectable, Logger, Inject} from "@nestjs/common"
import {WORKFLOW_ACTION_EMAIL_QUEUE} from "@external"
import {TaskService} from "@services/task/task.service"
import {EmailService} from "@services/email/email.service"
import {WORKER_ID} from "../worker.constants"
import {WorkflowActionType, WorkflowActionEmailEvent, WorkflowActionEmailTaskFactory} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {isLeft} from "fp-ts/lib/Either"

@Injectable()
@Processor(WORKFLOW_ACTION_EMAIL_QUEUE)
export class WorkflowActionEmailProcessor {
  constructor(
    private readonly taskService: TaskService,
    private readonly emailService: EmailService,
    @Inject(WORKER_ID) private readonly workerId: string
  ) {}

  @Process("workflow-action-email")
  async handleEmailAction(job: Job<WorkflowActionEmailEvent>) {
    const event = job.data
    Logger.log(`Processing email action for task ${event.taskId}`)

    const processResult = await pipe(
      TE.Do,
      TE.bindW("lockOwner", () => TE.right(this.workerId)),
      TE.bindW("task", () => this.taskService.getEmailTask(event.taskId)),
      TE.bindW("lockResult", ({task, lockOwner}) =>
        this.taskService.lockTask({type: WorkflowActionType.EMAIL, taskId: task.id}, lockOwner)
      ),
      TE.bindW("emailResult", ({task}) =>
        pipe(
          this.emailService.sendEmail({
            to: task.recipients,
            subject: task.subject,
            htmlBody: task.body
          }),
          TE.orElseW(error => TE.right(error))
        )
      ),
      TE.bindW("updatedResult", ({task, lockResult, emailResult, lockOwner}) => {
        const checks = {
          occ: lockResult.occ,
          lockOwner
        }

        if (typeof emailResult === "string") {
          // Email sending failed
          Logger.error(`Email execution failed: ${emailResult}`)
          return pipe(
            WorkflowActionEmailTaskFactory.toFailedEmail(task, {
              errorReason: `Unable to send email: ${emailResult}`
            }),
            TE.fromEither,
            TE.chainW(data => this.taskService.updateEmailTask(data, checks))
          )
        }

        // Email succeeded
        Logger.log("Email execution completed successfully")
        return pipe(
          WorkflowActionEmailTaskFactory.toCompletedEmail(task),
          TE.fromEither,
          TE.chainW(data => this.taskService.updateEmailTask(data, checks))
        )
      }),
      TE.chainW(({task, updatedResult}) => {
        Logger.log(`Releasing lock for task ${task.id}`)

        const releaseChecks = {
          occ: updatedResult.occ,
          lockOwner: this.workerId
        }

        return this.taskService.releaseLock({type: WorkflowActionType.EMAIL, taskId: task.id}, releaseChecks)
      })
    )()

    if (isLeft(processResult)) {
      Logger.error(`Task processing failed: ${JSON.stringify(processResult.left)}`)
      throw new Error(`Starting email task failed: ${JSON.stringify(processResult.left)}`)
    }
    Logger.log(`Task processing completed successfully for task ${event.taskId}`)
  }
}
