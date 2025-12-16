import {Process, Processor} from "@nestjs/bull"
import {Job} from "bull"
import {Injectable, Logger, Inject} from "@nestjs/common"
import {WORKFLOW_ACTION_WEBHOOK_QUEUE} from "@external"
import {TaskService} from "@services/task/task.service"
import {WebhookService} from "@services/webhook/webhook.service"
import {WORKER_ID} from "../worker.constants"
import {
  TaskStatus,
  WorkflowActionType,
  WorkflowActionWebhookEvent,
  WorkflowActionTaskDecoratorSelector,
  WorkflowActionWebhookTaskFactory,
  DecoratedWorkflowActionWebhookCompletedTask,
  DecoratedWorkflowActionWebhookErrorTask
} from "@domain"
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
      // 2. Fetch the task data (moved up to make 'task' available for locking)
      TE.bindW("task", () => this.taskService.getWebhookTask(event.taskId)),
      // 1. Lock the task (now uses 'task.id' from the fetched task)
      TE.bindW("lockResult", ({task}) =>
        this.taskService.lockTask({type: WorkflowActionType.WEBHOOK, taskId: task.id}, this.workerId)
      ),
      // 3. Execute Webhook
      TE.bindW("webhookResult", ({task}) =>
        pipe(
          this.webhookService.executeWebhook(task.url, task.method, task.headers, task.payload),
          // Map all the left errors to right undefined with the magic meaning that the call failed,
          // and no response was received. This is needed to keep proceeding on the right path.
          // It might still possible to it on the left side with a more idiomatic fp-ts way,
          // but I don't know how to do it. Will revise in the future if needed.
          TE.orElseW(error => TE.right(error))
        )
      ),
      // 4. Update Task with Result
      TE.bindW("updateResult", ({task, lockResult, webhookResult}) => {
        const checks = {
          occ: lockResult.occ,
          lockOwner: this.workerId
        }

        if (typeof webhookResult === "string") {
          // Webhook call failed without reaching the server, we don't have the response.
          return pipe(
            WorkflowActionWebhookTaskFactory.toFailedWebhook(task, {
              response: null,
              errorReason: `Webhook execution failed: ${webhookResult}`
            }),
            TE.fromEither,
            TE.chainW(data => this.taskService.updateWebhookTask(data, checks))
          )
        } else {
          // Check HTTP status code - 2xx is success, others are errors
          if (webhookResult.status >= 200 && webhookResult.status < 300) {
            // Webhook succeeded - update task as COMPLETED
            const updatedTask: DecoratedWorkflowActionWebhookCompletedTask<WorkflowActionTaskDecoratorSelector> = {
              ...task,
              status: TaskStatus.COMPLETED,
              response: {
                status: webhookResult.status,
                body: webhookResult.body,
                bodyStatus: webhookResult.bodyStatus
              },
              updatedAt: new Date()
            }
            return this.taskService.updateWebhookTask(updatedTask, checks)
          } else {
            // Webhook returned error status code - update task as ERROR
            const updatedTask: DecoratedWorkflowActionWebhookErrorTask<WorkflowActionTaskDecoratorSelector> = {
              ...task,
              status: TaskStatus.ERROR,
              response: {
                status: webhookResult.status,
                body: webhookResult.body,
                bodyStatus: webhookResult.bodyStatus
              },
              retryCount: task.retryCount + 1,
              errorReason: `Webhook returned error status: ${webhookResult.status}`,
              updatedAt: new Date()
            }
            return this.taskService.updateWebhookTask(updatedTask, checks)
          }
        }
      }),
      // 5. Release lock
      TE.chainW(({task, updateResult}) => {
        const checks = {
          occ: updateResult.occ,
          lockOwner: this.workerId
        }

        return this.taskService.releaseLock({type: WorkflowActionType.WEBHOOK, taskId: task.id}, checks)
      })
    )()

    if (isLeft(processResult)) {
      throw new Error(`Starting webhook task failed: ${JSON.stringify(processResult.left)}`)
    }
  }
}
