import {Either, left, right} from "fp-ts/Either"
import {Brand, brand, isDate, isObject} from "@utils"

declare const _DeliveryPermitBrand: unique symbol

interface DeliveryPermitData {
  readonly owner: string
  readonly fencing: bigint
  readonly expiresAt: Date
}

/** An expiring reservation for one delivery concurrency slot, issued by the limiter. */
export type DeliveryPermit = Brand<DeliveryPermitData, typeof _DeliveryPermitBrand>

export type DeliveryPermitValidationError =
  | "delivery_permit_malformed_object"
  | "delivery_permit_invalid_owner"
  | "delivery_permit_invalid_fencing"
  | "delivery_permit_invalid_expires_at"

export class DeliveryPermitFactory {
  static validate(data: unknown): Either<DeliveryPermitValidationError, DeliveryPermit> {
    if (!isObject(data)) return left("delivery_permit_malformed_object")
    if (typeof data.owner !== "string" || !data.owner.trim()) return left("delivery_permit_invalid_owner")
    if (typeof data.fencing !== "bigint") return left("delivery_permit_invalid_fencing")
    if (!isDate(data.expiresAt) || !Number.isFinite(data.expiresAt.getTime()))
      return left("delivery_permit_invalid_expires_at")
    return right(
      brand<DeliveryPermitData, typeof _DeliveryPermitBrand>({
        owner: data.owner,
        fencing: data.fencing,
        expiresAt: data.expiresAt
      })
    )
  }
}
