import {
  TaskReadyEvent,
  TenantEvent,
  UsageSettlementEvent,
  WorkflowRecalculateEvent,
  WorkflowStatusChangedEvent
} from "@domain"

/**
 * Queue JSON cannot encode bigint OCC versions. Replace the selected keys K of
 * event T with strings, preserving the other fields. For example,
 * VersionedPayload<TaskReadyEvent, "taskOcc"> makes taskOcc a string.
 * This only describes the payload type; serializeTenantEvent converts the values.
 */
type VersionedPayload<T, K extends keyof T> = Omit<T, K> & {[P in K]: string}

type WorkflowStatusChangedPayload = Omit<WorkflowStatusChangedEvent, "workflowOcc" | "occurredAt"> & {
  workflowOcc: string
  occurredAt: string
}

export type TenantEventQueuePayload =
  | VersionedPayload<TaskReadyEvent, "taskOcc">
  | WorkflowRecalculateEvent
  | WorkflowStatusChangedPayload
  | UsageSettlementEvent

export function serializeTenantEvent(event: TenantEvent): TenantEventQueuePayload {
  if (event.type === "workflow.status_changed")
    return {
      ...event,
      workflowOcc: event.workflowOcc.toString(),
      occurredAt: event.occurredAt.toISOString()
    }
  if (event.type === "task.ready") return {...event, taskOcc: event.taskOcc.toString()}
  return event
}
