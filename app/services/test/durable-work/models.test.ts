import * as E from "fp-ts/Either"
import {LeaseFactory} from "@domain"
import {
  AuditRecordFactory,
  DispatchClaimFactory,
  DispatchClaimResultFactory,
  DispatchCompletionFactory,
  OutboxClaimFactory,
  UsageCacheSnapshotFactory,
  UsageOperationFactory,
  UsageSettlementFactory,
  UsageSettlementResultFactory
} from "@services/durable-work/models"
import {randomOrgId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

const operation = {
  organizationId: randomOrgId(),
  operationId: uuidv7(),
  metric: "MAX_LLM_TOKENS_PER_MONTH",
  period: "2026-10",
  entityType: "Workflow",
  entityId: uuidv7(),
  actor: {type: "user", id: uuidv7(), displayName: "Owner"},
  estimatedUnits: 10,
  isBillable: true
}
const lease = {owner: uuidv7(), fencing: 1n, expiresAt: new Date("2026-10-04T12:00:00Z")}
const attempt = {attemptId: uuidv7(), occ: 0n, lease}
const cacheOperation = {operationId: operation.operationId, estimatedUnits: 10, revision: "0", state: "reserved"}
const audit = {
  organizationId: operation.organizationId,
  id: uuidv7(),
  actor: operation.actor,
  entityType: operation.entityType,
  entityId: operation.entityId,
  action: "created",
  occurredAt: new Date(),
  payload: {source: "test"}
}

describe("Durable work model factories", () => {
  it.each<[unknown, string]>([
    [null, "usage_operation_malformed_object"],
    [{...operation, organizationId: "invalid"}, "invalid_organization_id"],
    [{...operation, operationId: "invalid"}, "invalid_operation_id"],
    [{...operation, metric: "unknown"}, "invalid_metric"],
    [{...operation, period: "2026-13"}, "billing_period_invalid_month"],
    [{...operation, period: "1999-10"}, "billing_period_invalid_year"],
    [{...operation, period: "invalid"}, "billing_period_invalid_format"],
    [{...operation, entityType: " "}, "invalid_entity_type"],
    [{...operation, entityId: "invalid"}, "invalid_entity_id"],
    [{...operation, actor: {...operation.actor, id: "invalid"}}, "invalid_actor_id"],
    [{...operation, actor: {...operation.actor, type: "system"}}, "invalid_actor"],
    [{...operation, actor: {...operation.actor, displayName: " "}}, "invalid_actor"],
    [{...operation, estimatedUnits: 0.5}, "invalid_estimated_units"],
    [{...operation, estimatedUnits: Number.MAX_SAFE_INTEGER + 1}, "invalid_estimated_units"],
    [{...operation, isBillable: "true"}, "invalid_billable_flag"]
  ])("rejects malformed usage %j with %s", (input, error) => {
    // When
    const result = UsageOperationFactory.validate(input)
    // Expect
    expect(result).toEqual(E.left(error))
  })

  it("constructs a validated operation and accepts zero estimated units", () => {
    // Given
    const input = {...operation, estimatedUnits: 0}
    // When
    const result = unwrapRight(UsageOperationFactory.validate(input))
    // Expect
    expect(result).toEqual(input)
  })

  it.each<[unknown, string]>([
    [{...operation, state: "settled", revision: "-1", actualUnits: 0}, "invalid_revision"],
    [{...operation, state: "settled", revision: "1"}, "invalid_actual_units"],
    [{...operation, state: "settled", revision: "1", actualUnits: Infinity}, "invalid_actual_units"],
    [{...operation, state: "cancelled", revision: "1", actualUnits: 0}, "invalid_actual_units"],
    [{...operation, state: "reserved", revision: "0"}, "invalid_settlement_state"]
  ])("rejects inconsistent settlement %j with %s", (input, error) => {
    // When
    const result = UsageSettlementFactory.validate(input)
    // Expect
    expect(result).toEqual(E.left(error))
  })

  it("omits actual units for a cancelled settlement mapped from a nullable database column", () => {
    // Given
    const input = {...operation, revision: "1", state: "cancelled", actualUnits: null}
    // When
    const result = unwrapRight(UsageSettlementFactory.validate(input))
    // Expect
    expect(result).toEqual({...operation, revision: "1", state: "cancelled"})
    expect(result).not.toHaveProperty("actualUnits")
  })

  it.each<[unknown, string]>([
    [{state: "settled", actualUnits: -1}, "invalid_actual_units"],
    [{state: "cancelled", actualUnits: 1}, "invalid_actual_units"],
    [{state: "reserved"}, "invalid_settlement_state"],
    [null, "usage_settlement_malformed_object"]
  ])("rejects invalid settlement result %j with %s", (input, error) => {
    // When
    const result = UsageSettlementResultFactory.validate(input)
    // Expect
    expect(result).toEqual(E.left(error))
  })

  it.each<[unknown, string]>([
    [{consumed: -1, operations: []}, "invalid_consumed_units"],
    [{consumed: 0, operations: [cacheOperation, cacheOperation]}, "duplicate_usage_operation"],
    [{consumed: Number.MAX_SAFE_INTEGER, operations: [cacheOperation]}, "usage_snapshot_quantity_overflow"],
    [{consumed: 0, operations: [{...cacheOperation, state: "settled"}]}, "invalid_actual_units"],
    [{consumed: 0, operations: [{...cacheOperation, actualUnits: 0}]}, "invalid_actual_units"],
    [{consumed: 0, operations: [{...cacheOperation, revision: "01"}]}, "invalid_revision"],
    [{consumed: 0, operations: [{...cacheOperation, estimatedUnits: NaN}]}, "invalid_estimated_units"]
  ])("rejects unsafe recovery snapshot %j with %s", (input, error) => {
    // When
    const result = UsageCacheSnapshotFactory.validate(input)
    // Expect
    expect(result).toEqual(E.left(error))
  })

  it("constructs a recovery snapshot without non-applicable actual units", () => {
    // Given
    const input = {consumed: 15, operations: [{...cacheOperation, actualUnits: null}]}
    // When
    const result = unwrapRight(UsageCacheSnapshotFactory.validate(input))
    // Expect
    expect(result).toEqual({consumed: 15, operations: [cacheOperation]})
  })

  it.each<[unknown, string]>([
    [{...lease, owner: " "}, "lease_invalid_owner"],
    [{...lease, fencing: 1}, "lease_invalid_fencing"],
    [{...lease, expiresAt: new Date(NaN)}, "lease_invalid_expires_at"]
  ])("rejects invalid lease %p with %s", (input, error) => {
    // When
    const result = LeaseFactory.validate(input)
    // Expect
    expect(result).toEqual(E.left(error))
  })

  it("validates an expired lease structurally without claiming that it is still owned", () => {
    // Given
    const input = {...lease, expiresAt: new Date(0)}
    // When
    const result = LeaseFactory.validate(input)
    // Expect
    expect(result).toEqual(E.right(input))
  })

  it("accepts a claim with signed OCC and fencing", () => {
    // Given
    const input = {...attempt, occ: -1n, lease: {...lease, fencing: -1n}}
    // When
    const result = DispatchClaimFactory.validate(input)
    // Expect
    expect(result).toEqual(E.right(input))
  })

  it("preserves nested lease errors when validating an admitted dispatch", () => {
    // Given
    const input = {state: "admitted", ...attempt, lease: {...lease, fencing: "invalid"}}
    // When
    const result = DispatchClaimResultFactory.validate(input)
    // Expect
    expect(result).toEqual(E.left("lease_invalid_fencing"))
  })

  it("constructs a parked result without attempt fields", () => {
    // When
    const result = DispatchClaimResultFactory.validate({state: "parked"})
    // Expect
    expect(result).toEqual(E.right({state: "parked"}))
  })

  it.each<[unknown, string]>([
    [{...attempt, attemptId: "invalid"}, "dispatch_invalid_attempt_id"],
    [{...attempt, occ: "invalid"}, "dispatch_invalid_occ"]
  ])("rejects invalid attempt %p with %s", (input, error) => {
    // When
    const result = DispatchClaimFactory.validate(input)
    // Expect
    expect(result).toEqual(E.left(error))
  })

  it("validates event and lease together when constructing an outbox claim", () => {
    // Given
    const event = {
      organizationId: operation.organizationId,
      eventId: uuidv7(),
      schemaVersion: 1,
      type: "workflow.recalculate",
      workflowId: uuidv7()
    }
    // When
    const valid = OutboxClaimFactory.validate({event, lease})
    const invalid = OutboxClaimFactory.validate({event: {...event, eventId: null}, lease})
    // Expect
    expect(valid).toEqual(E.right({event, lease}))
    expect(invalid).toEqual(E.left("tenant_event_event_id_invalid"))
  })

  it("constructs valid audit and completion models", () => {
    // Given
    const completion = {state: "succeeded", outcome: {type: "http_response", statusCode: 200}} as const
    // When
    const auditResult = AuditRecordFactory.validate(audit)
    const completionResult = DispatchCompletionFactory.validate(completion)
    // Expect
    expect(auditResult).toEqual(E.right(audit))
    expect(completionResult).toEqual(E.right(completion))
  })

  it.each<[unknown, string]>([
    [{...audit, id: "invalid"}, "audit_record_invalid_id"],
    [{...audit, action: " "}, "audit_record_invalid_action"],
    [{...audit, occurredAt: new Date(NaN)}, "audit_record_invalid_occurred_at"],
    [{...audit, payload: []}, "audit_record_invalid_payload"]
  ])("rejects invalid audit record %j with %s", (input, error) => {
    // When
    const result = AuditRecordFactory.validate(input)
    // Expect
    expect(result).toEqual(E.left(error))
  })
})
