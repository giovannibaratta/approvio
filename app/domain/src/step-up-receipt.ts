import {isStepUpOperation, StepUpOperation} from "./authenticated-entity"
import {TenantContext, isOrganizationId} from "./shared"
import {Either, left, right} from "fp-ts/Either"
import {Brand, brand, isObject, isUUIDv7} from "@utils"
import {v7 as uuidv7} from "uuid"

interface StepUpReceiptData extends TenantContext {
  readonly id: string
  readonly jti: string
  readonly userId: string
  readonly sessionId: string
  readonly providerId: string
  readonly contextVersion: bigint
  readonly operation: StepUpOperation
  readonly resourceId: string
  readonly expiresAt: Date
  readonly createdAt: Date
  readonly consumedAt: Date | null
}

declare const _StepUpReceiptBrand: unique symbol
export type StepUpReceipt = Brand<StepUpReceiptData, typeof _StepUpReceiptBrand>

/**
 * Expected receipt fields reconstructed from the authenticated principal and
 * step-up token when authorizing an operation.
 */
export type StepUpReceiptClaim = Omit<StepUpReceiptData, "id" | "expiresAt" | "createdAt" | "consumedAt">

/** A consumption timestamp is the sole record of the receipt's one-way transition. */
export type ConsumedStepUpReceipt = StepUpReceipt & {readonly consumedAt: Date}

export type StepUpReceiptValidationError =
  | "step_up_receipt_malformed_object"
  | "step_up_receipt_invalid_id"
  | "step_up_receipt_invalid_organization_id"
  | "step_up_receipt_invalid_jti"
  | "step_up_receipt_invalid_user_id"
  | "step_up_receipt_invalid_session_id"
  | "step_up_receipt_invalid_provider_id"
  | "step_up_receipt_invalid_context_version"
  | "step_up_receipt_invalid_operation"
  | "step_up_receipt_invalid_resource_id"
  | "step_up_receipt_invalid_expires_at"
  | "step_up_receipt_invalid_created_at"
  | "step_up_receipt_invalid_consumed_at"

export class StepUpReceiptFactory {
  static create(
    input: StepUpReceiptClaim & {readonly expiresAt: Date}
  ): Either<StepUpReceiptValidationError, StepUpReceipt> {
    return StepUpReceiptFactory.validate({...input, id: uuidv7(), createdAt: new Date(), consumedAt: null})
  }

  static validate(data: unknown): Either<StepUpReceiptValidationError, StepUpReceipt> {
    if (!isObject(data)) return left("step_up_receipt_malformed_object")
    if (typeof data.id !== "string" || !isUUIDv7(data.id)) return left("step_up_receipt_invalid_id")
    if (!isOrganizationId(data.organizationId)) return left("step_up_receipt_invalid_organization_id")
    if (typeof data.jti !== "string") return left("step_up_receipt_invalid_jti")
    if (typeof data.userId !== "string") return left("step_up_receipt_invalid_user_id")
    if (typeof data.sessionId !== "string") return left("step_up_receipt_invalid_session_id")
    if (typeof data.providerId !== "string") return left("step_up_receipt_invalid_provider_id")
    if (typeof data.contextVersion !== "bigint") return left("step_up_receipt_invalid_context_version")
    if (!isStepUpOperation(data.operation)) return left("step_up_receipt_invalid_operation")
    if (typeof data.resourceId !== "string") return left("step_up_receipt_invalid_resource_id")
    if (!(data.expiresAt instanceof Date)) return left("step_up_receipt_invalid_expires_at")
    if (!(data.createdAt instanceof Date)) return left("step_up_receipt_invalid_created_at")
    if (data.consumedAt !== null && !(data.consumedAt instanceof Date))
      return left("step_up_receipt_invalid_consumed_at")

    return right(
      brand<StepUpReceiptData, typeof _StepUpReceiptBrand>({
        id: data.id,
        organizationId: data.organizationId,
        jti: data.jti,
        userId: data.userId,
        sessionId: data.sessionId,
        providerId: data.providerId,
        contextVersion: data.contextVersion,
        operation: data.operation,
        resourceId: data.resourceId,
        expiresAt: data.expiresAt,
        createdAt: data.createdAt,
        consumedAt: data.consumedAt
      })
    )
  }

  /** Authorize the claim and transition the issued receipt to consumed at the time of use. */
  static consume(
    receipt: StepUpReceipt,
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
      receipt.consumedAt !== null ||
      receipt.expiresAt <= consumedAt
    )
      return left("invalid_credential")

    return right({...receipt, consumedAt})
  }
}
