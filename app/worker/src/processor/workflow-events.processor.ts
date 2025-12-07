import {Process, Processor} from "@nestjs/bull"
import {Logger} from "@nestjs/common"
import {Job} from "bull"
import {WORKFLOW_STATUS_CHANGED_QUEUE} from "@external"
import {v5 as uuidv5} from "uuid"
import {QueueService} from "@services"
import {
  WorkflowStatusChangedEvent,
  WorkflowActionType,
  WorkflowActionEmailTaskFactory,
  WorkflowActionWebhookTaskFactory,
  WorkflowStatus,
  WorkflowAction,
  Workflow,
  EmailAction,
  WebhookAction
} from "@domain"
import {TaskCreateError, TaskService} from "@services"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {isLeft} from "fp-ts/lib/Either"
import {WorkflowService} from "@services"

@Processor(WORKFLOW_STATUS_CHANGED_QUEUE)
export class WorkflowEventsProcessor {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly taskService: TaskService,
    private readonly queueService: QueueService
  ) {}

  @Process("workflow-status-changed")
  async handleWorkflowStatusChanged(job: Job<WorkflowStatusChangedEvent>) {
    const event = job.data
    Logger.log(`Processing status change for workflow ${event.workflowId}: ${event.oldStatus} -> ${event.newStatus}`)

    if (event.newStatus === WorkflowStatus.EVALUATION_IN_PROGRESS) return

    const processResult = await pipe(
      TE.Do,
      TE.chainW(() => this.workflowService.getWorkflowByIdentifier(event.workflowId, {workflowTemplate: true})),
      TE.chainW(workflowWithTemplate => {
        // Use the snapshotted actions instead of the fresh data to avoid inconsistency in case the
        // workflow template has been modified during an even reprocessing (e.g. due to a failure).
        const tasks = event.workflowTemplateActions.map((action, index) =>
          this.processAction(action, workflowWithTemplate, event, index)
        )
        return TE.sequenceArray(tasks)
      })
    )()

    if (isLeft(processResult))
      throw new Error(`Failed to process workflow status change: ${JSON.stringify(processResult.left)}`)
  }

  private processAction(
    action: WorkflowAction,
    workflow: Workflow,
    event: WorkflowStatusChangedEvent,
    index: number
  ): TE.TaskEither<TaskCreateError, void> {
    // We generate a deterministic task ID based on event ID, action type, and index.
    // This allows us to ensure idempotency: if the handler triggers multiple times for the same event,
    // we will generate the same ID.
    // The `task_already_exists` error will be caught and ignored, preventing duplicate tasks.
    // The Queue will also deduplicate based on this ID for the event emission.
    const NAMESPACE = "95650ca4-d361-11f0-8d0d-325096b39f47"
    const taskName = `${event.eventId}-${action.type}-${index}`
    const taskId = uuidv5(taskName, NAMESPACE)

    switch (action.type) {
      case WorkflowActionType.EMAIL:
        return this.handleEmailAction(action, workflow, event, taskId)
      case WorkflowActionType.WEBHOOK:
        return this.handleWebhookAction(action, workflow, event, taskId)
    }
  }

  private handleEmailAction(
    action: EmailAction,
    workflow: Workflow,
    event: WorkflowStatusChangedEvent,
    taskId: string
  ): TE.TaskEither<TaskCreateError, void> {
    const task = WorkflowActionEmailTaskFactory.newWorkflowActionEmailTask({
      id: taskId,
      workflowId: workflow.id,
      recipients: Array.from(action.recipients),
      subject: `Workflow ${workflow.name} status update`,
      body: `The workflow ${workflow.name} has transitioned from ${event.oldStatus} to ${event.newStatus} at ${event.timestamp.toISOString()}.`
    })

    return pipe(
      this.taskService.createEmailTask(task),
      TE.orElse(error => {
        if (error === "task_already_exists") {
          Logger.warn(`Email task ${taskId} already exists, skipping creation.`)
          return TE.right(undefined)
        }
        return TE.left(error)
      }),
      TE.chain(() =>
        pipe(
          this.queueService.enqueueEmailAction({
            taskId: task.id,
            workflowId: workflow.id
          }),
          TE.mapLeft(error => {
            Logger.error(`Failed to add email task ${task.id} to queue`, error)
            return "unknown_error" as const
          })
        )
      )
    )
  }

  private handleWebhookAction(
    action: WebhookAction,
    workflow: Workflow,
    event: WorkflowStatusChangedEvent,
    taskId: string
  ): TE.TaskEither<TaskCreateError, void> {
    const task = WorkflowActionWebhookTaskFactory.newWorkflowActionWebhookTask({
      id: taskId,
      workflowId: workflow.id,
      url: action.url,
      method: action.method,
      headers: action.headers,
      payload: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        status: workflow.status,
        occurredAt: event.timestamp
      }
    })

    return pipe(
      this.taskService.createWebhookTask(task),
      TE.orElse(error => {
        if (error === "task_already_exists") {
          Logger.warn(`Webhook task ${taskId} already exists, skipping creation.`)
          return TE.right(undefined)
        }
        return TE.left(error)
      }),
      TE.chain(() =>
        pipe(
          this.queueService.enqueueWebhookAction({
            taskId: task.id,
            workflowId: workflow.id
          }),
          TE.mapLeft(error => {
            Logger.error(`Failed to add webhook task ${task.id} to queue`, error)
            return "unknown_error" as const
          })
        )
      )
    )
  }
}
