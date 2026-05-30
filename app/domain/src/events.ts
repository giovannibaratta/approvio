import {WorkflowAction, WorkflowActionType} from "./workflow-actions"
import {WorkflowStatus} from "./workflows"

export interface WorkflowStatusChangedEvent {
  eventId: string
  workflowId: string
  oldStatus: WorkflowStatus
  newStatus: WorkflowStatus
  // Snapshot of the workflow template actions at the time of the event.
  // This is not an ideal solution because we are overloading the event but will keep the implementation
  // simple for now.
  workflowTemplateActions: ReadonlyArray<WorkflowAction>
  timestamp: Date
}

// A single interface with a type selector that unifies workflow action events.
interface WorkflowActionEvent<T extends WorkflowActionType = WorkflowActionType> {
  type: T
  taskId: string
  workflowId: string
}

export type WorkflowActionEmailEvent = WorkflowActionEvent<WorkflowActionType.EMAIL>
export type WorkflowActionSlackEvent = WorkflowActionEvent<WorkflowActionType.SLACK>
export type WorkflowActionWebhookEvent = WorkflowActionEvent<WorkflowActionType.WEBHOOK>
