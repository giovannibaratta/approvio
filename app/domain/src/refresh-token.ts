import {createSha256Hash, getStringAsEnum, hasOwnProperty, isObject, isUUIDv7, PrefixUnion} from "@utils"
import {Either, left, right} from "fp-ts/Either"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {v7 as uuidv7} from "uuid"

import {Agent} from "./agent"
import {TenantContext, Versioned} from "./shared"

export enum RefreshTokenStatus {
  ACTIVE = "active",
  USED = "used",
  REVOKED = "revoked"
}

export type RefreshTokenValidationError = PrefixUnion<
  "refresh_token",
  | "invalid_structure"
  | "invalid_id"
  | "invalid_token_hash"
  | "invalid_family_id"
  | "invalid_account_id"
  | "invalid_session_id"
  | "invalid_provider_connection_id"
  | "invalid_organization_id"
  | "invalid_agent_id"
  | "invalid_status"
  | "invalid_created_at"
  | "invalid_expires_at"
  | "expire_before_create"
  | "invalid_used_at"
  | "used_before_create"
  | "invalid_next_token_id"
  | "missing_occ"
>

interface RefreshTokenBase {
  readonly id: string
  /**
   * Hash of the token value. The token value is not stored in the persistence layer,
   * this can be used to retrieve the information of a token.
   */
  readonly tokenHash: string
  /**
   * Family identifier for token revocation. The family identifier is unique per
   * session, revoking a family will "kill" a single session without affecting
   * other sessions.
   */
  readonly familyId: string
  readonly expiresAt: Date
  readonly createdAt: Date
}

export interface AccountRefreshTokenIdentity {
  readonly kind: "account"
  readonly accountId: string
  readonly sessionId: string
  readonly providerConnectionId: string
}

export interface AgentRefreshTokenIdentity extends TenantContext {
  readonly kind: "agent"
  readonly agentId: string
}

export interface ActiveRefreshTokenStatus {
  readonly status: RefreshTokenStatus.ACTIVE
}

export interface UsedRefreshTokenStatus {
  readonly status: RefreshTokenStatus.USED
  readonly usedAt: Date
  readonly nextTokenId: string
}

export interface RevokedRefreshTokenStatus {
  readonly status: RefreshTokenStatus.REVOKED
}

type RefreshTokenState = ActiveRefreshTokenStatus | UsedRefreshTokenStatus | RevokedRefreshTokenStatus

export type AccountRefreshToken = RefreshTokenBase & AccountRefreshTokenIdentity & RefreshTokenState
export type AgentRefreshToken = RefreshTokenBase & AgentRefreshTokenIdentity & RefreshTokenState
export type RefreshToken = AccountRefreshToken | AgentRefreshToken

export type ActiveAccountRefreshToken = AccountRefreshToken & ActiveRefreshTokenStatus
export type ActiveAgentRefreshToken = AgentRefreshToken & ActiveRefreshTokenStatus
export type UsedAccountRefreshToken = AccountRefreshToken & UsedRefreshTokenStatus
export type UsedAgentRefreshToken = AgentRefreshToken & UsedRefreshTokenStatus
export type VersionedAccountRefreshToken = Versioned<AccountRefreshToken>
export type VersionedAgentRefreshToken = Versioned<AgentRefreshToken>
export type VersionedActiveAccountRefreshToken = Versioned<ActiveAccountRefreshToken>
export type VersionedActiveAgentRefreshToken = Versioned<ActiveAgentRefreshToken>

/**
 * Grace period for token reuse detection after the expiration date.
 * The grace period is used to handle possible race conditions when inside a single session, the
 * client attempts to refresh the same token in parallel in a short period of time. This will
 * remove responsibility from the client to handle the race condition.
 */
export const GRACE_PERIOD_SECONDS = 30
export const REFRESH_TOKEN_EXPIRY_DAYS = 30

type GeneratedTokenBase = RefreshTokenBase & {readonly tokenValue: string}

function generateTokenBase(familyIdOverride?: string): GeneratedTokenBase {
  const now = new Date()
  const tokenValue = uuidv7()

  return {
    id: uuidv7(),
    tokenHash: createSha256Hash(tokenValue),
    familyId: familyIdOverride ?? uuidv7(),
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    createdAt: now,
    tokenValue
  }
}

function validateBase(data: Record<string, unknown>): Either<RefreshTokenValidationError, RefreshTokenBase> {
  if (!hasOwnProperty(data, "id") || typeof data.id !== "string" || !isUUIDv7(data.id))
    return left("refresh_token_invalid_id")
  if (!hasOwnProperty(data, "tokenHash") || typeof data.tokenHash !== "string" || data.tokenHash.length === 0)
    return left("refresh_token_invalid_token_hash")
  if (!hasOwnProperty(data, "familyId") || typeof data.familyId !== "string" || !isUUIDv7(data.familyId))
    return left("refresh_token_invalid_family_id")
  if (!hasOwnProperty(data, "createdAt") || !(data.createdAt instanceof Date))
    return left("refresh_token_invalid_created_at")
  if (!hasOwnProperty(data, "expiresAt") || !(data.expiresAt instanceof Date))
    return left("refresh_token_invalid_expires_at")
  if (data.expiresAt < data.createdAt) return left("refresh_token_expire_before_create")

  return right({
    id: data.id,
    tokenHash: data.tokenHash,
    familyId: data.familyId,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt
  })
}

function validateState(
  data: Record<string, unknown>,
  createdAt: Date
): Either<RefreshTokenValidationError, RefreshTokenState> {
  if (!hasOwnProperty(data, "status") || typeof data.status !== "string") return left("refresh_token_invalid_status")

  const status = getStringAsEnum(data.status, RefreshTokenStatus)
  if (status === undefined) return left("refresh_token_invalid_status")
  if (status === RefreshTokenStatus.ACTIVE) return right({status: RefreshTokenStatus.ACTIVE})
  if (status === RefreshTokenStatus.REVOKED) return right({status: RefreshTokenStatus.REVOKED})
  if (!hasOwnProperty(data, "usedAt") || !(data.usedAt instanceof Date)) return left("refresh_token_invalid_used_at")
  if (data.usedAt < createdAt) return left("refresh_token_used_before_create")
  if (!hasOwnProperty(data, "nextTokenId") || typeof data.nextTokenId !== "string" || !isUUIDv7(data.nextTokenId))
    return left("refresh_token_invalid_next_token_id")

  return right({status: RefreshTokenStatus.USED, usedAt: data.usedAt, nextTokenId: data.nextTokenId})
}

function validateOcc(data: Record<string, unknown>): Either<RefreshTokenValidationError, bigint> {
  return hasOwnProperty(data, "occ") && typeof data.occ === "bigint"
    ? right(data.occ)
    : left("refresh_token_missing_occ")
}

export class AccountRefreshTokenFactory {
  static create(
    accountId: string,
    sessionId: string,
    providerConnectionId: string,
    familyId?: string
  ): Either<RefreshTokenValidationError, VersionedActiveAccountRefreshToken & {readonly tokenValue: string}> {
    const {tokenValue, ...base} = generateTokenBase(familyId)
    const token: VersionedActiveAccountRefreshToken = {
      ...base,
      kind: "account",
      accountId,
      sessionId,
      providerConnectionId,
      status: RefreshTokenStatus.ACTIVE,
      occ: 0n
    }
    const validated = this.validateVersioned(token)
    return pipe(
      validated,
      E.map(() => ({...token, tokenValue}))
    )
  }

  static validate(data: unknown): Either<RefreshTokenValidationError, AccountRefreshToken> {
    if (!isObject(data)) return left("refresh_token_invalid_structure")
    const base = validateBase(data)
    if (base._tag === "Left") return base
    const state = validateState(data, base.right.createdAt)
    if (state._tag === "Left") return state
    if (data.kind !== "account") return left("refresh_token_invalid_structure")
    if (!hasOwnProperty(data, "accountId") || typeof data.accountId !== "string" || !isUUIDv7(data.accountId))
      return left("refresh_token_invalid_account_id")
    if (!hasOwnProperty(data, "sessionId") || typeof data.sessionId !== "string" || !isUUIDv7(data.sessionId))
      return left("refresh_token_invalid_session_id")
    if (
      !hasOwnProperty(data, "providerConnectionId") ||
      typeof data.providerConnectionId !== "string" ||
      !isUUIDv7(data.providerConnectionId)
    )
      return left("refresh_token_invalid_provider_connection_id")

    return right({
      ...base.right,
      ...state.right,
      kind: "account",
      accountId: data.accountId,
      sessionId: data.sessionId,
      providerConnectionId: data.providerConnectionId
    })
  }

  static validateVersioned(data: unknown): Either<RefreshTokenValidationError, VersionedAccountRefreshToken> {
    if (!isObject(data)) return left("refresh_token_invalid_structure")
    return pipe(
      this.validate(data),
      E.chain(token =>
        pipe(
          validateOcc(data),
          E.map(occ => ({...token, occ}))
        )
      )
    )
  }

  static markAsUsed(
    token: AccountRefreshToken,
    nextTokenId: string,
    usedAt = new Date()
  ): Either<RefreshTokenValidationError, UsedAccountRefreshToken> {
    const candidate: UsedAccountRefreshToken = {...token, status: RefreshTokenStatus.USED, usedAt, nextTokenId}
    return pipe(
      AccountRefreshTokenFactory.validate(candidate),
      E.map(() => candidate)
    )
  }
}

export class AgentRefreshTokenFactory {
  static create(
    agent: Agent,
    familyId?: string
  ): Either<RefreshTokenValidationError, VersionedActiveAgentRefreshToken & {readonly tokenValue: string}> {
    const {tokenValue, ...base} = generateTokenBase(familyId)
    const token: VersionedActiveAgentRefreshToken = {
      ...base,
      kind: "agent",
      organizationId: agent.organizationId,
      agentId: agent.id,
      status: RefreshTokenStatus.ACTIVE,
      occ: 0n
    }
    const validated = this.validateVersioned(token)
    return pipe(
      validated,
      E.map(() => ({...token, tokenValue}))
    )
  }

  static validate(data: unknown): Either<RefreshTokenValidationError, AgentRefreshToken> {
    if (!isObject(data)) return left("refresh_token_invalid_structure")
    const base = validateBase(data)
    if (base._tag === "Left") return base
    const state = validateState(data, base.right.createdAt)
    if (state._tag === "Left") return state
    if (data.kind !== "agent") return left("refresh_token_invalid_structure")
    if (
      !hasOwnProperty(data, "organizationId") ||
      typeof data.organizationId !== "string" ||
      !isUUIDv7(data.organizationId)
    )
      return left("refresh_token_invalid_organization_id")
    if (!hasOwnProperty(data, "agentId") || typeof data.agentId !== "string" || !isUUIDv7(data.agentId))
      return left("refresh_token_invalid_agent_id")

    return right({
      ...base.right,
      ...state.right,
      kind: "agent",
      organizationId: data.organizationId,
      agentId: data.agentId
    })
  }

  static validateVersioned(data: unknown): Either<RefreshTokenValidationError, VersionedAgentRefreshToken> {
    if (!isObject(data)) return left("refresh_token_invalid_structure")
    return pipe(
      this.validate(data),
      E.chain(token =>
        pipe(
          validateOcc(data),
          E.map(occ => ({...token, occ}))
        )
      )
    )
  }

  static markAsUsed(
    token: AgentRefreshToken,
    nextTokenId: string,
    usedAt = new Date()
  ): Either<RefreshTokenValidationError, UsedAgentRefreshToken> {
    const candidate: UsedAgentRefreshToken = {...token, status: RefreshTokenStatus.USED, usedAt, nextTokenId}
    return pipe(
      AgentRefreshTokenFactory.validate(candidate),
      E.map(() => candidate)
    )
  }
}

export type RefreshTokenEligibilityError =
  "refresh_token_expired" | "refresh_token_revoked" | "refresh_token_reuse_detected"

// TODO: Check removed helpers and comments

/**
 * Applies expiry, family-revocation, and bounded token-reuse checks before a
 * refresh rotation. The grace interval admits a concurrent retry from the
 * same client while preserving reuse detection after that interval.
 */
export function canTokenBeRefreshed(token: RefreshToken, time: Date): Either<RefreshTokenEligibilityError, true> {
  if (token.expiresAt < time) return left("refresh_token_expired")
  if (token.status === RefreshTokenStatus.REVOKED) return left("refresh_token_revoked")
  if (token.status === RefreshTokenStatus.USED && time.getTime() - token.usedAt.getTime() > GRACE_PERIOD_SECONDS * 1000)
    return left("refresh_token_reuse_detected")
  return right(true)
}
