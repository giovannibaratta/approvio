import {TaskReadyEvent, TenantEvent, TenantEventFactory, TenantEventValidationError} from "@domain"
import {TenantOutbox} from "@prisma/client"
import * as E from "fp-ts/Either"

/** Only events tied to a specific resource revision carry a version. */
type PersistenceEnvelope = {readonly resourceId: string; readonly resourceVersion?: bigint}

export function toPersistenceEnvelope(event: TenantEvent): PersistenceEnvelope {
  switch (event.type) {
    case "task.ready":
      return {resourceId: event.taskId, resourceVersion: event.taskOcc}
    case "workflow.recalculate":
      // Reevaluation targets the current workflow state, without specifying a revision.
      return {resourceId: event.workflowId}
    case "workflow.status_changed":
      return {resourceId: event.workflowId, resourceVersion: event.workflowOcc}
    case "usage.settlement":
      return {resourceId: event.operationId}
    case "organization.resumed":
      return {resourceId: event.organizationId}
  }
}

export function toEvent(
  row: TenantOutbox
): E.Either<"event_mismatch" | TenantEventValidationError, TenantEvent | TaskReadyEvent> {
  const event = TenantEventFactory.validate(row.payload)
  if (E.isLeft(event)) return event

  // Identity, type and version fields are duplicated in columns for database queries and constraints.
  // The factory validates only the JSON payload; these checks ensure both copies remain consistent.
  const envelope = toPersistenceEnvelope(event.right)
  if (
    event.right.organizationId !== row.organizationId ||
    event.right.eventId !== row.eventId ||
    event.right.type !== row.eventType ||
    event.right.schemaVersion !== row.schemaVersion ||
    envelope.resourceId !== row.resourceId ||
    envelope.resourceVersion !== (row.resourceVersion ?? undefined)
  )
    return E.left("event_mismatch")
  return event
}
