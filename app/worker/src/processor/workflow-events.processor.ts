import {Process, Processor} from "@nestjs/bull"
import {Logger} from "@nestjs/common"
import {Job} from "bull"
import {WORKFLOW_STATUS_CHANGED_QUEUE} from "@external"
import {v5 as uuidv5} from "uuid"
import {
  WorkflowStatusChangedEvent,
  WorkflowActionType,
  WorkflowActionEmailTaskFactory,
  WorkflowActionWebhookTaskFactory,
  WorkflowActionSlackTaskFactory,
  WorkflowStatus,
  WorkflowAction,
  Workflow,
  EmailAction,
  WebhookAction,
  SlackAction,
  WorkflowActionWebhookTaskValidationError,
  WorkflowActionEmailTaskValidationError,
  WorkflowActionSlackTaskValidationError,
  TenantEventFactory
} from "@domain"
import {TaskGenerationRequest, TaskService} from "@services"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {isLeft} from "fp-ts/Either"
import {WorkflowService} from "@services"
import {logSuccess} from "@utils"
import {TenantContext} from "@domain"

@Processor(WORKFLOW_STATUS_CHANGED_QUEUE)
export class WorkflowEventsProcessor {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly taskService: TaskService
  ) {}

  @Process("workflow-status-changed")
  async handleWorkflowStatusChanged(job: Pick<Job<unknown>, "data">) {
    const event = this.deserializeAndValidateEvent(job.data)
    const context: TenantContext = {organizationId: event.organizationId}
    Logger.log(`Processing status change for workflow ${event.workflowId}: ${event.previousStatus} -> ${event.status}`)

    if (event.status === WorkflowStatus.EVALUATION_IN_PROGRESS) {
      const result = await this.taskService.createEventTasks(context, event.eventId, [])()
      if (isLeft(result)) throw new Error(`Failed to record workflow event ${event.eventId}: ${result.left}`)
      return
    }

    const processResult = await pipe(
      TE.Do,
      TE.chainW(() =>
        this.workflowService.getWorkflowByIdentifier(context, event.workflowId, {workflowTemplate: true})
      ),
      TE.chainW(workflowWithTemplate => {
        // Use the snapshotted actions instead of the fresh data to avoid inconsistency in case the
        // workflow template has been modified during event reprocessing (e.g. due to a failure).
        const tasks = event.workflowTemplateActions.map((action, index) =>
          this.processAction(action, workflowWithTemplate, event, index)
        )
        return pipe(
          TE.sequenceArray(tasks),
          TE.chainW(requests => this.taskService.createEventTasks(context, event.eventId, requests)),
          TE.map(() => undefined)
        )
      }),
      logSuccess(`Event ${event.eventId} processed successfully`, "WorkflowEventProcessor")
    )()

    if (isLeft(processResult)) {
      Logger.error(`Failed to process workflow status change: ${JSON.stringify(processResult.left)}`)
      throw new Error(`Failed to process workflow status change: ${JSON.stringify(processResult.left)}`)
    }
  }

  private processAction(
    action: WorkflowAction,
    workflow: Workflow,
    event: WorkflowStatusChangedEvent,
    index: number
  ): TE.TaskEither<
    | WorkflowActionWebhookTaskValidationError
    | WorkflowActionEmailTaskValidationError
    | WorkflowActionSlackTaskValidationError,
    TaskGenerationRequest
  > {
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
        return this.handleEmailAction(action, workflow, event, taskId, index)
      case WorkflowActionType.WEBHOOK:
        return this.handleWebhookAction(action, workflow, event, taskId, index)
      case WorkflowActionType.SLACK:
        return this.handleSlackAction(action, workflow, event, taskId, index)
    }
  }

  private handleEmailAction(
    action: EmailAction,
    workflow: Workflow,
    event: WorkflowStatusChangedEvent,
    taskId: string,
    actionIndex: number
  ): TE.TaskEither<WorkflowActionEmailTaskValidationError, TaskGenerationRequest> {
    return pipe(
      TE.fromEither(
        WorkflowActionEmailTaskFactory.newWorkflowActionEmailTask({
          id: taskId,
          organizationId: event.organizationId,
          workflowId: workflow.id,
          recipients: Array.from(action.recipients),
          subject: `Workflow ${workflow.name} status update`,
          body: `The workflow ${workflow.name} has transitioned from ${event.previousStatus} to ${event.status} at ${event.occurredAt.toISOString()}.`
        })
      ),
      TE.map(task => ({kind: "email", request: {task, metadata: taskMetadata(event, actionIndex)}}) as const)
    )
  }

  private handleWebhookAction(
    action: WebhookAction,
    workflow: Workflow,
    event: WorkflowStatusChangedEvent,
    taskId: string,
    actionIndex: number
  ): TE.TaskEither<WorkflowActionWebhookTaskValidationError, TaskGenerationRequest> {
    return pipe(
      TE.fromEither(
        WorkflowActionWebhookTaskFactory.newWorkflowActionWebhookTask({
          id: taskId,
          organizationId: event.organizationId,
          workflowId: workflow.id,
          url: action.url,
          method: action.method,
          headers: action.headers,
          payload: {
            workflowId: workflow.id,
            workflowName: workflow.name,
            status: workflow.status,
            occurredAt: event.occurredAt
          }
        })
      ),
      TE.map(task => ({kind: "webhook", request: {task, metadata: taskMetadata(event, actionIndex)}}) as const)
    )
  }

  private handleSlackAction(
    action: SlackAction,
    workflow: Workflow,
    event: WorkflowStatusChangedEvent,
    taskId: string,
    actionIndex: number
  ): TE.TaskEither<WorkflowActionSlackTaskValidationError, TaskGenerationRequest> {
    return pipe(
      TE.fromEither(
        WorkflowActionSlackTaskFactory.newWorkflowActionSlackTask({
          id: taskId,
          organizationId: event.organizationId,
          workflowId: workflow.id,
          webhookUrl: action.webhookUrl,
          message: `The workflow ${workflow.name} has transitioned from ${event.previousStatus} to ${event.status} at ${event.occurredAt.toISOString()}.`
        })
      ),
      TE.map(task => ({kind: "slack", request: {task, metadata: taskMetadata(event, actionIndex)}}) as const)
    )
  }

  private deserializeAndValidateEvent(data: unknown): WorkflowStatusChangedEvent {
    const validated = TenantEventFactory.validate(data)
    if (isLeft(validated)) throw new Error(`Invalid workflow status-change event: ${validated.left}`)
    if (validated.right.type !== "workflow.status_changed") throw new Error("Expected a workflow.status_changed event")
    return validated.right
  }
}

function taskMetadata(event: WorkflowStatusChangedEvent, actionIndex: number) {
  return {
    eventId: event.eventId,
    actionIndex,
    availableAt: event.occurredAt
  }
}
