import {
  OrganizationResumedEvent,
  TaskReadyEvent,
  TenantEvent,
  UsageSettlementEvent,
  WorkflowRecalculateEvent,
  WorkflowStatusChangedTenantEvent
} from "@domain"

type VersionedPayload<T, K extends keyof T> = Omit<T, K> & {[P in K]: string}

type WorkflowStatusChangedPayload = Omit<WorkflowStatusChangedTenantEvent, "workflowOcc" | "occurredAt"> & {
  workflowOcc: string
  occurredAt: string
}

export type TenantEventQueuePayload =
  | VersionedPayload<TaskReadyEvent, "taskOcc">
  | WorkflowRecalculateEvent
  | WorkflowStatusChangedPayload
  | OrganizationResumedEvent
  | VersionedPayload<UsageSettlementEvent, "operationOcc">

export function serializeTenantEvent(event: TenantEvent): TenantEventQueuePayload {
  if (event.type === "workflow.status_changed")
    return {
      ...event,
      workflowOcc: event.workflowOcc.toString(),
      occurredAt: event.occurredAt.toISOString()
    }
  if (event.type === "task.ready") return {...event, taskOcc: event.taskOcc.toString()}
  if (event.type === "usage.settlement") return {...event, operationOcc: event.operationOcc.toString()}
  return event
}
