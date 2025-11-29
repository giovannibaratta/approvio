import {WorkflowStatus} from "./workflows"

export interface WorkflowStatusChangedEvent {
  workflowId: string
  oldStatus: WorkflowStatus
  newStatus: WorkflowStatus
  timestamp: Date
}
