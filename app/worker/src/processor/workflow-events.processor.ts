import {Process, Processor} from "@nestjs/bull"
import {Logger} from "@nestjs/common"
import {Job} from "bull"
import {WORKFLOW_STATUS_CHANGED_QUEUE} from "@external"
import {v5 as uuidv5} from "uuid"
import {
  WorkflowTaskGenerationEvent,
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
  validateWorkflowActions,
  Actor,
  isOrganizationId
} from "@domain"
import {TaskGenerationRequest, TaskService} from "@services"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {isLeft} from "fp-ts/Either"
import {WorkflowService} from "@services"
import {logSuccess, getStringAsEnum} from "@utils"
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
    Logger.log(
      `Processing status change for workflow ${event.workflowId}: ${event.previousStatus} -> ${event.newStatus}`
    )

    if (event.newStatus === WorkflowStatus.EVALUATION_IN_PROGRESS) {
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
        // workflow template has been modified during an even reprocessing (e.g. due to a failure).
        const actions =
          event.workflowTemplateActions.length > 0
            ? event.workflowTemplateActions
            : (workflowWithTemplate.workflowTemplate?.actions ?? [])
        const tasks = actions.map((action, index) => this.processAction(action, workflowWithTemplate, event, index))
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
    event: WorkflowTaskGenerationEvent,
    index: number
  ): TE.TaskEither<
    | WorkflowActionWebhookTaskValidationError
    | WorkflowActionEmailTaskValidationError
    | WorkflowActionSlackTaskValidationError,
    TaskGenerationRequest
  > {
    // Stable IDs let a receipt-free legacy attempt be verified and reused on replay.
    const taskName = `${event.eventId}-${action.type}-${index}`
    const taskId = uuidv5(taskName, "95650ca4-d361-11f0-8d0d-325096b39f47")

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
    event: WorkflowTaskGenerationEvent,
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
          body: `The workflow ${workflow.name} has transitioned from ${event.previousStatus} to ${event.newStatus} at ${event.occurredAt.toISOString()}.`
        })
      ),
      TE.map(task => ({kind: "email", request: {task, metadata: taskMetadata(event, actionIndex)}}) as const)
    )
  }

  private handleWebhookAction(
    action: WebhookAction,
    workflow: Workflow,
    event: WorkflowTaskGenerationEvent,
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
    event: WorkflowTaskGenerationEvent,
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
          message: `The workflow ${workflow.name} has transitioned from ${event.previousStatus} to ${event.newStatus} at ${event.occurredAt.toISOString()}.`
        })
      ),
      TE.map(task => ({kind: "slack", request: {task, metadata: taskMetadata(event, actionIndex)}}) as const)
    )
  }

  private deserializeAndValidateEvent(data: unknown): WorkflowTaskGenerationEvent {
    if (!isRecord(data)) throw new Error("Job data is not an object")
    const raw = data
    if (typeof raw.eventId !== "string") throw new Error("Missing or invalid eventId")
    const workflowId = raw.workflowId
    if (typeof workflowId !== "string") throw new Error("Missing or invalid workflowId")
    if (typeof raw.organizationId !== "string") throw new Error("Missing or invalid organizationId")
    if (typeof raw.previousStatus !== "string") throw new Error("Missing or invalid previousStatus")
    const oldStatus = getStringAsEnum(raw.previousStatus, WorkflowStatus)
    if (oldStatus === undefined) throw new Error("Invalid previousStatus value")
    if (typeof raw.status !== "string") throw new Error("Missing or invalid status")
    const newStatus = getStringAsEnum(raw.status, WorkflowStatus)
    if (newStatus === undefined) throw new Error("Invalid status value")

    const actionsValidation = validateWorkflowActions(raw.workflowTemplateActions ?? [])
    if (isLeft(actionsValidation))
      throw new Error(`Invalid workflowTemplateActions: ${JSON.stringify(actionsValidation.left)}`)

    const workflowTemplateActions = actionsValidation.right

    if (!isOrganizationId(raw.organizationId)) throw new Error("Missing or invalid organizationId")
    if (typeof raw.occurredAt !== "string" && !(raw.occurredAt instanceof Date))
      throw new Error("Missing or invalid occurredAt")

    const occurredAt = new Date(raw.occurredAt)
    if (isNaN(occurredAt.getTime())) throw new Error("Invalid occurredAt date format")
    const actor = parseActor(raw.actor)
    if (actor === undefined) throw new Error("Missing or invalid actor")

    return {
      eventId: raw.eventId,
      workflowId,
      organizationId: raw.organizationId,
      previousStatus: oldStatus,
      newStatus,
      workflowTemplateActions,
      occurredAt,
      actor
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function taskMetadata(event: WorkflowTaskGenerationEvent, actionIndex: number) {
  return {
    eventId: event.eventId,
    actionIndex,
    availableAt: event.occurredAt
  }
}

function parseActor(value: unknown): Actor | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.displayName !== "string" || !value.displayName.trim()) return undefined
  if (value.type === "system") {
    if (value.id !== undefined && typeof value.id !== "string") return undefined
    return {type: "system", displayName: value.displayName}
  }
  if (
    (value.type === "user" || value.type === "agent" || value.type === "operator") &&
    typeof value.id === "string" &&
    value.id.trim()
  )
    return {id: value.id, displayName: value.displayName, type: value.type}
  return undefined
}
