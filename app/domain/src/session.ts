import {Either, left, right} from "fp-ts/Either"
import {Brand, brand, isObject, isUUIDv7} from "@utils"
import {v7 as uuidv7} from "uuid"
import {OrganizationId, Versioned, isOrganizationId} from "./shared"

interface SessionData {
  readonly id: string
  readonly accountId: string
  readonly providerId: string
  /** Absent until the account deliberately selects an organization. */
  readonly selectedOrganizationId?: OrganizationId
  /** Changes whenever the selected organization changes. */
  readonly contextVersion: bigint
  readonly transport: "browser" | "cli"
  readonly status: "active" | "revoked"
  readonly expiresAt: Date
  readonly createdAt: Date
  readonly updatedAt: Date
}

declare const _SessionBrand: unique symbol
export type SessionState = Brand<SessionData, typeof _SessionBrand>
export type Session = Versioned<SessionState>

export type SessionValidationError = "invalid_credential" | "session_invalid_id" | "session_invalid_account_id"

export class SessionFactory {
  static create(input: {
    readonly accountId: string
    readonly providerId: string
    readonly transport: "browser" | "cli"
    readonly expiresAt: Date
  }): Either<SessionValidationError, SessionState> {
    const now = new Date()
    if (input.expiresAt <= now) return left("invalid_credential")
    return SessionFactory.validate({
      ...input,
      id: uuidv7(),
      contextVersion: 0n,
      status: "active",
      createdAt: now,
      updatedAt: now
    })
  }

  static validate(data: unknown): Either<SessionValidationError, SessionState> {
    if (!isObject(data)) return left("invalid_credential")
    if (!isUuidV7String(data.id)) return left("session_invalid_id")
    if (!isUuidV7String(data.accountId)) return left("session_invalid_account_id")
    if (typeof data.providerId !== "string" || !data.providerId.trim()) return left("invalid_credential")
    if (data.selectedOrganizationId !== undefined && !isOrganizationId(data.selectedOrganizationId))
      return left("invalid_credential")
    if (typeof data.contextVersion !== "bigint") return left("invalid_credential")
    if (data.transport !== "browser" && data.transport !== "cli") return left("invalid_credential")
    if (data.status !== "active" && data.status !== "revoked") return left("invalid_credential")
    if (!isValidDate(data.expiresAt)) return left("invalid_credential")
    if (!isValidDate(data.createdAt)) return left("invalid_credential")
    if (!isValidDate(data.updatedAt)) return left("invalid_credential")
    if (data.updatedAt < data.createdAt || data.expiresAt <= data.createdAt) return left("invalid_credential")

    return right(
      brand<SessionData, typeof _SessionBrand>({
        id: data.id,
        accountId: data.accountId,
        providerId: data.providerId,
        selectedOrganizationId: data.selectedOrganizationId,
        contextVersion: data.contextVersion,
        transport: data.transport,
        status: data.status,
        expiresAt: data.expiresAt,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt
      })
    )
  }

  static switchContext(
    session: Session,
    organizationId: OrganizationId,
    expectedOcc: bigint
  ): Either<"invalid_credential" | "organization_context_changed", Session> {
    if (session.occ !== expectedOcc) return left("organization_context_changed")
    const now = new Date()
    if (session.status !== "active" || session.expiresAt <= now) return left("invalid_credential")
    return right({
      ...session,
      selectedOrganizationId: organizationId,
      contextVersion: session.contextVersion + 1n,
      updatedAt: now
    })
  }
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function isUuidV7String(value: unknown): value is string {
  return typeof value === "string" && isUUIDv7(value)
}
