import {WorkflowAction} from "./workflow-actions"
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
