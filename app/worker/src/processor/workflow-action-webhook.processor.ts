import {Process, Processor} from "@nestjs/bull"
import {Job} from "bull"
import {Injectable, Logger, Inject} from "@nestjs/common"
import {WORKFLOW_ACTION_WEBHOOK_QUEUE} from "@external"
import {TaskService} from "@services/task/task.service"
import {WebhookService} from "@services/webhook/webhook.service"
import {WORKER_ID} from "../worker.constants"
import {WorkflowActionType, WorkflowActionWebhookEvent, WorkflowActionWebhookTaskFactory} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {isLeft} from "fp-ts/lib/Either"

@Injectable()
@Processor(WORKFLOW_ACTION_WEBHOOK_QUEUE)
export class WorkflowActionWebhookProcessor {
  constructor(
    private readonly taskService: TaskService,
    private readonly webhookService: WebhookService,
    @Inject(WORKER_ID) private readonly workerId: string
  ) {}

  @Process("workflow-action-webhook")
  async handleWebhookAction(job: Job<WorkflowActionWebhookEvent>) {
    const event = job.data
    Logger.log(`Processing webhook action for task ${event.taskId}`)

    const processResult = await pipe(
      TE.Do,
      TE.bindW("lockOwner", () => TE.right(this.workerId)),
      TE.bindW("task", () => this.taskService.getWebhookTask(event.taskId)),
      TE.bindW("lockResult", ({task, lockOwner}) =>
        this.taskService.lockTask({type: WorkflowActionType.WEBHOOK, taskId: task.id}, lockOwner)
      ),
      TE.bindW("webhookResult", ({task}) =>
        pipe(
          this.webhookService.executeWebhook(task.url, task.method, task.headers, task.payload),
          // Map all the left errors to right string with the magic meaning that the call failed,
          // and no response was received. This is needed to keep proceeding on the right path.
          // It might still possible to it on the left side with a more idiomatic fp-ts way,
          // but I don't know how to do it. Will revise in the future if needed.
          TE.orElseW(error => TE.right(error))
        )
      ),
      TE.bindW("updatedResult", ({task, lockResult, webhookResult, lockOwner}) => {
        const checks = {
          occ: lockResult.occ,
          lockOwner
        }

        if (typeof webhookResult === "string") {
          // Webhook call failed without reaching the server, we don't have the response.
          Logger.error(`Webhook execution failed: ${webhookResult}`)
          return pipe(
            WorkflowActionWebhookTaskFactory.toFailedWebhook(task, {
              response: null,
              errorReason: `Webhook execution failed: ${webhookResult}`
            }),
            TE.fromEither,
            TE.chainW(data => this.taskService.updateWebhookTask(data, checks))
          )
        }

        if (webhookResult.status >= 200 && webhookResult.status < 300) {
          // Webhook succeeded - update task as COMPLETED
          Logger.log(`Webhook execution completed successfully: ${webhookResult.status}`)
          return pipe(
            WorkflowActionWebhookTaskFactory.toCompletedWebhook(task, {
              response: {
                status: webhookResult.status,
                body: webhookResult.body,
                bodyStatus: webhookResult.bodyStatus
              }
            }),
            TE.fromEither,
            TE.chainW(data => this.taskService.updateWebhookTask(data, checks))
          )
        }

        // Webhook returned error status code - update task as ERROR
        Logger.log(`Webhook execution completed with error: ${webhookResult.status}`)
        return pipe(
          WorkflowActionWebhookTaskFactory.toFailedWebhook(task, {
            response: {
              status: webhookResult.status,
              body: webhookResult.body,
              bodyStatus: webhookResult.bodyStatus
            },
            errorReason: `Webhook returned error status: ${webhookResult.status}`
          }),
          TE.fromEither,
          TE.chainW(data => this.taskService.updateWebhookTask(data, checks))
        )
      }),
      TE.chainW(({task, updatedResult}) => {
        Logger.log(`Releasing lock for task ${task.id}`)
        const checks = {
          occ: updatedResult.occ,
          lockOwner: this.workerId
        }

        return this.taskService.releaseLock({type: WorkflowActionType.WEBHOOK, taskId: task.id}, checks)
      })
    )()

    if (isLeft(processResult)) {
      Logger.error(`Task processing failed: ${JSON.stringify(processResult.left)}`)
      throw new Error(`Starting webhook task failed: ${JSON.stringify(processResult.left)}`)
    }
    Logger.log(`Task processing completed successfully for task ${event.taskId}`)
  }
}
