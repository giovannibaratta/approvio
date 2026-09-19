import {isStepUpOperation, StepUpOperation} from "./authenticated-entity"
import {TenantContext, isOrganizationId} from "./shared"
import {Either, left, right} from "fp-ts/Either"
import {isObject} from "@utils"

export interface StepUpReceipt extends TenantContext {
  readonly jti: string
  readonly userId: string
  readonly sessionId: string
  readonly providerId: string
  readonly contextVersion: bigint
  readonly operation: StepUpOperation
  readonly resourceId: string
  readonly expiresAt: Date
}

/**
 * Expected receipt fields reconstructed from the authenticated principal and
 * step-up token when authorizing an operation.
 */
export type StepUpReceiptClaim = Omit<StepUpReceipt, "expiresAt">

/** Consumption state of an issued receipt. Only a consumed receipt has a consumption time. */
export type UnconsumedStepUpReceipt = StepUpReceipt & {readonly status: "unconsumed"}
export type ConsumedStepUpReceipt = StepUpReceipt & {readonly status: "consumed"; readonly consumedAt: Date}
export type StepUpReceiptState = UnconsumedStepUpReceipt | ConsumedStepUpReceipt

type StepUpReceiptInput = Omit<StepUpReceipt, "organizationId"> & {readonly organizationId: string}

export type StepUpReceiptValidationError =
  | "step_up_receipt_malformed_object"
  | "step_up_receipt_invalid_organization_id"
  | "step_up_receipt_invalid_jti"
  | "step_up_receipt_invalid_user_id"
  | "step_up_receipt_invalid_session_id"
  | "step_up_receipt_invalid_provider_id"
  | "step_up_receipt_invalid_context_version"
  | "step_up_receipt_invalid_operation"
  | "step_up_receipt_invalid_resource_id"
  | "step_up_receipt_invalid_expires_at"
  | "step_up_receipt_invalid_status"
  | "step_up_receipt_invalid_consumed_at"

export class StepUpReceiptFactory {
  static validate(data: unknown): Either<StepUpReceiptValidationError, StepUpReceiptState> {
    if (!isObject(data)) return left("step_up_receipt_malformed_object")
    if (!isOrganizationId(data.organizationId)) return left("step_up_receipt_invalid_organization_id")
    if (typeof data.jti !== "string") return left("step_up_receipt_invalid_jti")
    if (typeof data.userId !== "string") return left("step_up_receipt_invalid_user_id")
    if (typeof data.sessionId !== "string") return left("step_up_receipt_invalid_session_id")
    if (typeof data.providerId !== "string") return left("step_up_receipt_invalid_provider_id")
    if (typeof data.contextVersion !== "bigint") return left("step_up_receipt_invalid_context_version")
    if (!isStepUpOperation(data.operation)) return left("step_up_receipt_invalid_operation")
    if (typeof data.resourceId !== "string") return left("step_up_receipt_invalid_resource_id")
    if (!(data.expiresAt instanceof Date)) return left("step_up_receipt_invalid_expires_at")

    const receipt: StepUpReceiptInput = {
      organizationId: data.organizationId,
      jti: data.jti,
      userId: data.userId,
      sessionId: data.sessionId,
      providerId: data.providerId,
      contextVersion: data.contextVersion,
      operation: data.operation,
      resourceId: data.resourceId,
      expiresAt: data.expiresAt
    }

    switch (data.status) {
      case "unconsumed":
        if (data.consumedAt !== undefined && data.consumedAt !== null)
          return left("step_up_receipt_invalid_consumed_at")
        return right({...receipt, organizationId: data.organizationId, status: "unconsumed"})
      case "consumed":
        if (!(data.consumedAt instanceof Date)) return left("step_up_receipt_invalid_consumed_at")
        return right({...receipt, organizationId: data.organizationId, status: "consumed", consumedAt: data.consumedAt})
      default:
        return left("step_up_receipt_invalid_status")
    }
  }

  /** Authorize the claim and transition the issued receipt to consumed at the time of use. */
  static consume(
    receipt: StepUpReceiptState,
    claim: StepUpReceiptClaim
  ): Either<"invalid_credential", ConsumedStepUpReceipt> {
    const consumedAt = new Date()

    if (
      receipt.organizationId !== claim.organizationId ||
      receipt.jti !== claim.jti ||
      receipt.userId !== claim.userId ||
      receipt.sessionId !== claim.sessionId ||
      receipt.providerId !== claim.providerId ||
      receipt.contextVersion !== claim.contextVersion ||
      receipt.operation !== claim.operation ||
      receipt.resourceId !== claim.resourceId ||
      receipt.status !== "unconsumed" ||
      receipt.expiresAt <= consumedAt
    )
      return left("invalid_credential")

    return right({...receipt, status: "consumed", consumedAt})
  }
}
