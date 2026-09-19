import {Actor} from "./authenticated-entity"
import {TenantContext} from "./shared"
import {WorkflowAction, WorkflowActionType} from "./workflow-actions"
import {WorkflowStatus} from "./workflows"

/** Versioned tenant event contracts used by the outbox, queue, and workers. */
export type EventType =
  "workflow.recalculate" | "workflow.status_changed" | "task.ready" | "organization.resumed" | "usage.settlement"

/** Common identity fields for durable tenant events. */
export interface EventBase extends TenantContext {
  readonly schemaVersion: 1
  readonly eventId: string
}

export type TaskKind = "email" | "webhook" | "slack"

export interface TaskReadyEvent extends EventBase {
  readonly type: "task.ready"
  readonly taskId: string
  readonly taskOcc: bigint
  readonly taskKind: TaskKind
}

export interface WorkflowRecalculateEvent extends EventBase {
  readonly type: "workflow.recalculate"
  readonly workflowId: string
}

export interface WorkflowStatusChangedTenantEvent extends EventBase {
  readonly type: "workflow.status_changed"
  readonly workflowId: string
  readonly workflowOcc: bigint
  readonly previousStatus: WorkflowStatus
  readonly status: WorkflowStatus
  readonly actor: Actor
  readonly occurredAt: Date
}

export interface OrganizationResumedEvent extends EventBase {
  readonly type: "organization.resumed"
}

export interface UsageSettlementEvent extends EventBase {
  readonly type: "usage.settlement"
  readonly operationId: string
  readonly operationOcc: bigint
}

export type TenantEvent =
  | TaskReadyEvent
  | WorkflowRecalculateEvent
  | WorkflowStatusChangedTenantEvent
  | OrganizationResumedEvent
  | UsageSettlementEvent

/** Worker input enriched with the workflow template snapshot used to create tasks. */
export interface WorkflowTaskGenerationEvent {
  readonly eventId: string
  readonly workflowId: string
  readonly organizationId: string
  readonly actor: Actor
  readonly previousStatus: WorkflowStatus
  readonly newStatus: WorkflowStatus
  readonly workflowTemplateActions: ReadonlyArray<WorkflowAction>
  readonly occurredAt: Date
}

interface WorkflowActionEvent<T extends WorkflowActionType = WorkflowActionType> {
  readonly type: T
  readonly taskId: string
  readonly workflowId: string
}

export type WorkflowActionEmailEvent = WorkflowActionEvent<WorkflowActionType.EMAIL>
export type WorkflowActionSlackEvent = WorkflowActionEvent<WorkflowActionType.SLACK>
export type WorkflowActionWebhookEvent = WorkflowActionEvent<WorkflowActionType.WEBHOOK>
