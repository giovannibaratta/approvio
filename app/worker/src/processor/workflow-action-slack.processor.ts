import {Process, Processor} from "@nestjs/bull"
import {Job} from "bull"
import {Injectable, Logger, Inject} from "@nestjs/common"
import {WORKFLOW_ACTION_SLACK_QUEUE} from "@external"
import {TaskService} from "@services"
import {SlackService} from "@services"
import {WORKER_ID} from "../worker.constants"
import {WorkflowActionType, WorkflowActionSlackEvent, WorkflowActionSlackTaskFactory, ResponseBodyStatus} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {isLeft} from "fp-ts/Either"

@Injectable()
@Processor(WORKFLOW_ACTION_SLACK_QUEUE)
export class WorkflowActionSlackProcessor {
  constructor(
    private readonly taskService: TaskService,
    private readonly slackService: SlackService,
    @Inject(WORKER_ID) private readonly workerId: string
  ) {}

  @Process("workflow-action-slack")
  async handleSlackAction(job: Job<WorkflowActionSlackEvent>) {
    const event = job.data
    Logger.log(`Processing slack action for task ${event.taskId}`)

    const processResult = await pipe(
      TE.Do,
      TE.bindW("lockOwner", () => TE.right(this.workerId)),
      TE.bindW("task", () => this.taskService.getSlackTask(event.taskId)),
      TE.bindW("lockResult", ({task, lockOwner}) =>
        this.taskService.lockTask({type: WorkflowActionType.SLACK, taskId: task.id}, lockOwner)
      ),
      TE.bindW("slackResult", ({task}) =>
        pipe(
          this.slackService.sendNotification({
            webhookUrl: task.webhookUrl,
            text: task.message || ""
          }),
          TE.map(() => ({status: 200, body: "ok", bodyStatus: ResponseBodyStatus.OK})),
          TE.orElseW(error => TE.right(error))
        )
      ),
      TE.bindW("updatedResult", ({task, lockResult, slackResult, lockOwner}) => {
        const checks = {
          occ: lockResult.occ,
          lockOwner
        }

        if (typeof slackResult === "string") {
          Logger.error(`Slack execution failed: ${slackResult}`)
          return pipe(
            WorkflowActionSlackTaskFactory.toFailedSlack(task, {
              response: null,
              errorReason: `Slack execution failed: ${slackResult}`
            }),
            TE.fromEither,
            TE.chainW(data => this.taskService.updateSlackTask(data, checks))
          )
        }

        Logger.log("Slack execution completed successfully")
        return pipe(
          WorkflowActionSlackTaskFactory.toCompletedSlack(task, {
            response: {
              status: 200,
              body: "ok",
              bodyStatus: ResponseBodyStatus.OK
            }
          }),
          TE.fromEither,
          TE.chainW(data => this.taskService.updateSlackTask(data, checks))
        )
      }),
      TE.chainW(({task, updatedResult}) => {
        Logger.log(`Releasing lock for task ${task.id}`)
        const checks = {
          occ: updatedResult.occ,
          lockOwner: this.workerId
        }

        return this.taskService.releaseLock({type: WorkflowActionType.SLACK, taskId: task.id}, checks)
      })
    )()

    if (isLeft(processResult)) {
      Logger.error(`Task processing failed: ${JSON.stringify(processResult.left)}`)
      throw new Error(`Starting slack task failed: ${JSON.stringify(processResult.left)}`)
    }
    Logger.log(`Task processing completed successfully for task ${event.taskId}`)
  }
}
