import {Either, left, right} from "fp-ts/Either"
import {Brand, brand, isDate, isObject} from "@utils"

declare const _OutboxPublicationStateBrand: unique symbol

type OutboxPublicationStateData =
  | {readonly state: "pending"}
  | {readonly state: "leased"; readonly owner: string; readonly expiresAt: Date}
  | {readonly state: "published"; readonly publishedAt: Date}

export type OutboxPublicationState = Brand<OutboxPublicationStateData, typeof _OutboxPublicationStateBrand>
export type OutboxPublicationStateValidationError = "outbox_publication_state_invalid"

export class OutboxPublicationStateFactory {
  static validate(data: unknown): Either<OutboxPublicationStateValidationError, OutboxPublicationState> {
    if (!isObject(data)) return left("outbox_publication_state_invalid")
    const {publishedAt, leaseOwner, leaseUntil} = data
    if (leaseOwner === null && leaseUntil === null) {
      if (publishedAt === null)
        return right(brand<OutboxPublicationStateData, typeof _OutboxPublicationStateBrand>({state: "pending"}))
      if (isDate(publishedAt) && Number.isFinite(publishedAt.getTime()))
        return right(
          brand<OutboxPublicationStateData, typeof _OutboxPublicationStateBrand>({state: "published", publishedAt})
        )
    }
    if (
      publishedAt === null &&
      typeof leaseOwner === "string" &&
      leaseOwner.trim() &&
      isDate(leaseUntil) &&
      Number.isFinite(leaseUntil.getTime())
    )
      return right(
        brand<OutboxPublicationStateData, typeof _OutboxPublicationStateBrand>({
          state: "leased",
          owner: leaseOwner,
          expiresAt: leaseUntil
        })
      )
    return left("outbox_publication_state_invalid")
  }
}
