import {Actor} from "./authenticated-entity"
import {TenantContext} from "./shared"
import {WorkflowAction, WorkflowActionType} from "./workflow-actions"
import {WorkflowStatus} from "./workflows"

/** Versioned tenant event contracts shared by outbox, queue, and workers. */
export type EventType =
  "workflow.recalculate" | "workflow.status_changed" | "task.ready" | "organization.resumed" | "usage.settlement"

export interface EventBase extends TenantContext {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly resourceId: string
  // TODO: What is the resource version ? The occ of the resource ?
  readonly resourceVersion: string
}

export type TaskKind = "email" | "webhook" | "slack"

export interface TaskEvent extends EventBase {
  // TODO: What other types are available ?
  readonly type: "task.ready"
  readonly taskId: string
  readonly taskKind: TaskKind
}

// TODO: not much readable. The eventBase & (...) could be break down with private (or public) interfaces.
export type TenantEvent =
  | TaskEvent
  | (EventBase &
      (
        | {readonly type: "workflow.recalculate"}
        // TODO: I am a bit confused. If we have the interface WorkflowStatusChangedEvent why are we redefining another one ?
        | {
            readonly type: "workflow.status_changed"
            // TODO: Does the statuses have a better type ?
            readonly previousStatus: string
            readonly status: string
            readonly actor: Actor
            // Why occuredAt is a string in the internal domain ?
            readonly occurredAt: string
          }
        | {readonly type: "organization.resumed"; readonly occ: string}
        // TODO: What is the revision ? occ ?
        | {readonly type: "usage.settlement"; readonly operationId: string; readonly revision: string}
      ))

export interface WorkflowStatusChangedEvent {
  eventId: string
  workflowId: string
  // TODO: Why are org id and actor optional ? Which events don't have them ?
  /** Organization selected by the outbox event; workers must not infer it from a global default. */
  organizationId?: string
  /** Actor snapshot used when creating durable task metadata. */
  actor?: Actor
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
