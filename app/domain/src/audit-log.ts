export interface AuditLog {
  id: string
  // TODO: This will be a discriminated union
  auditType: string
  // TODO: the actual entityType will be tied also to the audit type.
  entityType: string
  entityId: string
  actorId: string
  actorType: string
  payload: Record<string, unknown>
  createdAt: Date
}

export type CreateAuditLog = Omit<AuditLog, "id">
