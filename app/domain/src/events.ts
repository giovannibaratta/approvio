import {Actor} from "./authenticated-entity"
import {TenantContext, OrganizationId, isOrganizationId} from "./shared"
import {WorkflowAction, WorkflowActionType} from "./workflow-actions"
import {WorkflowStatus} from "./workflows"
import {Either, isLeft, left, right} from "fp-ts/Either"
import {PrefixUnion, getStringAsEnum, isObject} from "@utils"

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

type TenantEventInput<T extends EventType> = EventBase & Record<string, unknown> & {readonly type: T}

export type TenantEventValidationError = PrefixUnion<
  "tenant_event",
  | "malformed_object"
  | "organization_id_invalid"
  | "schema_version_invalid"
  | "event_id_invalid"
  | "type_invalid"
  | "task_id_invalid"
  | "task_kind_invalid"
  | "task_occ_invalid"
  | "workflow_id_invalid"
  | "workflow_occ_invalid"
  | "workflow_status_invalid"
  | "occurred_at_invalid"
  | "actor_malformed_object"
  | "actor_display_name_invalid"
  | "actor_type_invalid"
  | "actor_id_invalid"
  | "operation_id_invalid"
  | "operation_occ_invalid"
>

/** Validates an unknown serialized tenant event payload. */
export class TenantEventFactory {
  static validate(data: unknown): Either<TenantEventValidationError, TenantEvent> {
    if (!isObject(data)) return left("tenant_event_malformed_object")
    const base = validateEventBase(data)
    if (isLeft(base)) return base

    switch (data.type) {
      case "task.ready":
        return this.validateTaskReady({...data, ...base.right, type: data.type})
      case "workflow.recalculate":
        return this.validateWorkflowRecalculate({...data, ...base.right, type: data.type})
      case "organization.resumed":
        return right({...base.right, type: data.type})
      case "usage.settlement":
        return this.validateUsageSettlement({...data, ...base.right, type: data.type})
      case "workflow.status_changed":
        return this.validateWorkflowStatusChanged({...data, ...base.right, type: data.type})
      default:
        return left("tenant_event_type_invalid")
    }
  }

  private static validateTaskReady(
    data: TenantEventInput<"task.ready">
  ): Either<TenantEventValidationError, TaskReadyEvent> {
    if (typeof data.taskId !== "string") return left("tenant_event_task_id_invalid")
    if (!isTaskKind(data.taskKind)) return left("tenant_event_task_kind_invalid")
    if (typeof data.taskOcc !== "string") return left("tenant_event_task_occ_invalid")
    const taskOcc = parseBigInt(data.taskOcc)
    if (taskOcc === undefined) return left("tenant_event_task_occ_invalid")
    return right({
      organizationId: data.organizationId,
      schemaVersion: data.schemaVersion,
      eventId: data.eventId,
      type: data.type,
      taskId: data.taskId,
      taskOcc,
      taskKind: data.taskKind
    })
  }

  private static validateWorkflowRecalculate(
    data: TenantEventInput<"workflow.recalculate">
  ): Either<TenantEventValidationError, WorkflowRecalculateEvent> {
    if (typeof data.workflowId !== "string") return left("tenant_event_workflow_id_invalid")
    return right({
      organizationId: data.organizationId,
      schemaVersion: data.schemaVersion,
      eventId: data.eventId,
      type: data.type,
      workflowId: data.workflowId
    })
  }

  private static validateUsageSettlement(
    data: TenantEventInput<"usage.settlement">
  ): Either<TenantEventValidationError, UsageSettlementEvent> {
    if (typeof data.operationId !== "string") return left("tenant_event_operation_id_invalid")
    if (typeof data.operationOcc !== "string") return left("tenant_event_operation_occ_invalid")
    const operationOcc = parseBigInt(data.operationOcc)
    if (operationOcc === undefined) return left("tenant_event_operation_occ_invalid")
    return right({
      organizationId: data.organizationId,
      schemaVersion: data.schemaVersion,
      eventId: data.eventId,
      type: data.type,
      operationId: data.operationId,
      operationOcc
    })
  }

  private static validateWorkflowStatusChanged(
    data: TenantEventInput<"workflow.status_changed">
  ): Either<TenantEventValidationError, WorkflowStatusChangedTenantEvent> {
    if (typeof data.workflowId !== "string") return left("tenant_event_workflow_id_invalid")
    if (typeof data.workflowOcc !== "string") return left("tenant_event_workflow_occ_invalid")
    const workflowOcc = parseBigInt(data.workflowOcc)
    if (workflowOcc === undefined) return left("tenant_event_workflow_occ_invalid")
    if (typeof data.previousStatus !== "string" || typeof data.status !== "string")
      return left("tenant_event_workflow_status_invalid")
    const previousStatus = getStringAsEnum(data.previousStatus, WorkflowStatus)
    const status = getStringAsEnum(data.status, WorkflowStatus)
    if (previousStatus === undefined || status === undefined) return left("tenant_event_workflow_status_invalid")
    if (typeof data.occurredAt !== "string") return left("tenant_event_occurred_at_invalid")
    const occurredAt = new Date(data.occurredAt)
    if (Number.isNaN(occurredAt.getTime())) return left("tenant_event_occurred_at_invalid")
    const actor = parseActor(data.actor)
    if (isLeft(actor)) return actor

    return right({
      organizationId: data.organizationId,
      schemaVersion: data.schemaVersion,
      eventId: data.eventId,
      type: data.type,
      workflowId: data.workflowId,
      workflowOcc,
      previousStatus,
      status,
      actor: actor.right,
      occurredAt
    })
  }
}

function validateEventBase(data: Record<string, unknown>): Either<TenantEventValidationError, EventBase> {
  if (typeof data.organizationId !== "string" || !isOrganizationId(data.organizationId))
    return left("tenant_event_organization_id_invalid")
  if (data.schemaVersion !== 1) return left("tenant_event_schema_version_invalid")
  if (typeof data.eventId !== "string" || data.eventId.length === 0) return left("tenant_event_event_id_invalid")

  return right({organizationId: data.organizationId, schemaVersion: 1, eventId: data.eventId})
}

function isTaskKind(value: unknown): value is TaskKind {
  return value === "email" || value === "webhook" || value === "slack"
}

function parseBigInt(value: string): bigint | undefined {
  try {
    return BigInt(value)
  } catch {
    return undefined
  }
}

function parseActor(value: unknown): Either<TenantEventValidationError, Actor> {
  if (!isObject(value)) return left("tenant_event_actor_malformed_object")
  if (typeof value.displayName !== "string" || !value.displayName.trim())
    return left("tenant_event_actor_display_name_invalid")
  if (value.type === "system") {
    if (value.id !== undefined && typeof value.id !== "string") return left("tenant_event_actor_id_invalid")
    return right({type: "system", displayName: value.displayName})
  }
  if (value.type === "user" || value.type === "agent" || value.type === "operator") {
    if (typeof value.id !== "string" || !value.id.trim()) return left("tenant_event_actor_id_invalid")
    return right({id: value.id, displayName: value.displayName, type: value.type})
  }
  return left("tenant_event_actor_type_invalid")
}

/** Worker input enriched with the workflow template snapshot used to create tasks. */
export interface WorkflowTaskGenerationEvent {
  readonly eventId: string
  readonly workflowId: string
  readonly organizationId: OrganizationId
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
