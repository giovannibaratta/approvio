import {
  createSha256Hash,
  DecorableEntity,
  GeneratorSelector,
  getStringAsEnum,
  hasOwnProperty,
  isDecoratedWith,
  isObject,
  isUUIDv7,
  PrefixUnion
} from "@utils"
import {Either, left, right} from "fp-ts/Either"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {v7 as uuidv7} from "uuid"

import {Agent} from "./agent"
import {TenantContext} from "./shared"

/**
 * Refresh token status enum
 */
export enum RefreshTokenStatus {
  ACTIVE = "active",
  USED = "used",
  REVOKED = "revoked"
}

/**
 * Validation errors for refresh tokens
 */
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

/**
 * Base refresh token interface with common fields
 */
interface RefreshTokenBase {
  /**
   * Unique identifier for the token
   */
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
  /**
   * Expiration date of the token
   */
  readonly expiresAt: Date
  /**
   * Creation date of the token
   */
  readonly createdAt: Date
}

interface AccountRefreshTokenIdentity {
  readonly entityType: "account"
  readonly accountId: string
  readonly sessionId: string
  readonly providerConnectionId: string
}

interface AgentRefreshTokenIdentity extends TenantContext {
  readonly entityType: "agent"
  readonly agentId: string
}

export interface ActiveStatusProps {
  readonly status: RefreshTokenStatus.ACTIVE
}

export interface UsedStatusProps {
  readonly status: RefreshTokenStatus.USED
  readonly usedAt: Date
  readonly nextTokenId: string
}

export interface RevokedStatusProps {
  readonly status: RefreshTokenStatus.REVOKED
}

export interface RefreshTokenDecorators {
  occ: bigint
}

export type RefreshTokenDecoratorSelector = GeneratorSelector<RefreshTokenDecorators>

export type DecoratedRefreshToken<T extends RefreshTokenDecoratorSelector> = DecorableEntity<
  RefreshToken,
  RefreshTokenDecorators,
  T
>

export type DecoratedAccountRefreshToken<T extends RefreshTokenDecoratorSelector> = DecorableEntity<
  AccountRefreshToken,
  RefreshTokenDecorators,
  T
>
export type DecoratedAgentRefreshToken<T extends RefreshTokenDecoratorSelector> = DecorableEntity<
  AgentRefreshToken,
  RefreshTokenDecorators,
  T
>
export type DecoratedActiveAccountRefreshToken<T extends RefreshTokenDecoratorSelector> =
  DecoratedAccountRefreshToken<T> & ActiveStatusProps
export type DecoratedActiveAgentRefreshToken<T extends RefreshTokenDecoratorSelector> = DecoratedAgentRefreshToken<T> &
  ActiveStatusProps

type StatusProps = ActiveStatusProps | UsedStatusProps | RevokedStatusProps
type EntityProps = AccountRefreshTokenIdentity | AgentRefreshTokenIdentity
export type RefreshToken = RefreshTokenBase & EntityProps & StatusProps
export type AccountRefreshToken = RefreshToken & AccountRefreshTokenIdentity
export type AgentRefreshToken = RefreshToken & AgentRefreshTokenIdentity
export type UsedAccountRefreshToken = AccountRefreshToken & UsedStatusProps
export type UsedAgentRefreshToken = AgentRefreshToken & UsedStatusProps
/**
 * Grace period for token reuse detection after the expiration date.
 * The grace period is used to handle possible race conditions when inside a single session, the
 * client attempts to refresh the same token in parallel in a short period of time. This will
 * remove responsibility from the client to handle the race condition.
 */
export const GRACE_PERIOD_SECONDS = 30
export const REFRESH_TOKEN_EXPIRY_DAYS = 30

type GeneratedTokenBase = RefreshTokenBase & {readonly tokenValue: string}

type TokenWithValue<T> = T & {readonly tokenValue: string}

function addTokenValue<T>(token: T, tokenValue: string): TokenWithValue<T> {
  return {...token, tokenValue}
}

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
): Either<RefreshTokenValidationError, StatusProps> {
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

function validateCommon(data: unknown): Either<RefreshTokenValidationError, RefreshTokenBase & StatusProps> {
  if (!isObject(data)) return left("refresh_token_invalid_structure")
  const base = validateBase(data)
  if (E.isLeft(base)) return base
  const state = validateState(data, base.right.createdAt)
  if (E.isLeft(state)) return state

  return right({...base.right, ...state.right})
}

function validateAccountIdentity(
  data: Record<string, unknown>
): Either<RefreshTokenValidationError, AccountRefreshTokenIdentity> {
  if (data.entityType !== "account") return left("refresh_token_invalid_structure")
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
    entityType: "account",
    accountId: String(data.accountId),
    sessionId: String(data.sessionId),
    providerConnectionId: String(data.providerConnectionId)
  })
}

function validateAgentIdentity(
  data: Record<string, unknown>
): Either<RefreshTokenValidationError, AgentRefreshTokenIdentity> {
  if (data.entityType !== "agent") return left("refresh_token_invalid_structure")
  if (
    !hasOwnProperty(data, "organizationId") ||
    typeof data.organizationId !== "string" ||
    !isUUIDv7(data.organizationId)
  )
    return left("refresh_token_invalid_organization_id")
  if (!hasOwnProperty(data, "agentId") || typeof data.agentId !== "string" || !isUUIDv7(data.agentId))
    return left("refresh_token_invalid_agent_id")

  return right({
    entityType: "agent",
    organizationId: String(data.organizationId),
    agentId: String(data.agentId)
  })
}

function validateToken<T extends AccountRefreshTokenIdentity | AgentRefreshTokenIdentity>(
  data: unknown,
  validateIdentity: (data: Record<string, unknown>) => Either<RefreshTokenValidationError, T>
): Either<RefreshTokenValidationError, RefreshTokenBase & T & StatusProps> {
  const common = validateCommon(data)
  if (E.isLeft(common)) return common
  if (!isObject(data)) return left("refresh_token_invalid_structure")

  const identity = validateIdentity(data)
  if (E.isLeft(identity)) return identity

  return right({...common.right, ...identity.right})
}

function markTokenAsUsed<T extends RefreshToken>(
  token: T,
  nextTokenId: string,
  validate: (token: T & UsedStatusProps) => Either<RefreshTokenValidationError, RefreshToken>,
  usedAt = new Date()
): Either<RefreshTokenValidationError, T & UsedStatusProps> {
  const candidate = {...token, status: RefreshTokenStatus.USED, usedAt, nextTokenId} as T & UsedStatusProps
  return pipe(
    validate(candidate),
    E.map(() => candidate)
  )
}

function validateOcc(data: unknown): Either<RefreshTokenValidationError, bigint> {
  if (!isObject(data)) return left("refresh_token_missing_occ")
  if (!hasOwnProperty(data, "occ") || typeof data.occ !== "bigint") return left("refresh_token_missing_occ")
  return right(data.occ)
}

export class AccountRefreshTokenFactory {
  static create(
    accountId: string,
    sessionId: string,
    providerConnectionId: string,
    familyId?: string
  ): Either<
    RefreshTokenValidationError,
    DecoratedActiveAccountRefreshToken<{occ: true}> & {readonly tokenValue: string}
  > {
    const {tokenValue, ...base} = generateTokenBase(familyId)
    const token: DecoratedActiveAccountRefreshToken<{occ: true}> = {
      ...base,
      entityType: "account" as const,
      accountId,
      sessionId,
      providerConnectionId,
      status: RefreshTokenStatus.ACTIVE,
      occ: 0n
    }
    const validated = this.validate(token, {occ: true})
    return pipe(
      validated,
      E.map(() => addTokenValue(token, tokenValue))
    )
  }

  static validate<T extends RefreshTokenDecoratorSelector = RefreshTokenDecoratorSelector>(
    data: unknown,
    selectors?: T
  ): Either<RefreshTokenValidationError, DecoratedAccountRefreshToken<T>> {
    return AccountRefreshTokenFactory.validateToken(data, selectors)
  }

  private static validateToken(
    data: unknown,
    selectors?: RefreshTokenDecoratorSelector
  ): Either<RefreshTokenValidationError, AccountRefreshToken | (AccountRefreshToken & {readonly occ: bigint})> {
    const validated = validateToken(data, validateAccountIdentity)
    if (E.isLeft(validated)) return validated
    const token = validated.right
    if (selectors?.occ !== true) return right(token)
    const occ = validateOcc(data)
    if (E.isLeft(occ)) return occ
    return right({...token, occ: occ.right})
  }

  static markAsUsed(
    token: AccountRefreshToken,
    nextTokenId: string,
    usedAt = new Date()
  ): Either<RefreshTokenValidationError, UsedAccountRefreshToken> {
    return markTokenAsUsed(token, nextTokenId, candidate => AccountRefreshTokenFactory.validate(candidate), usedAt)
  }
}

export class AgentRefreshTokenFactory {
  static create(
    agent: Agent,
    familyId?: string
  ): Either<
    RefreshTokenValidationError,
    DecoratedActiveAgentRefreshToken<{occ: true}> & {readonly tokenValue: string}
  > {
    const {tokenValue, ...base} = generateTokenBase(familyId)
    const token: DecoratedActiveAgentRefreshToken<{occ: true}> = {
      ...base,
      entityType: "agent" as const,
      organizationId: agent.organizationId,
      agentId: agent.id,
      status: RefreshTokenStatus.ACTIVE,
      occ: 0n
    }
    const validated = this.validate(token, {occ: true})
    return pipe(
      validated,
      E.map(() => addTokenValue(token, tokenValue))
    )
  }

  static validate<T extends RefreshTokenDecoratorSelector = RefreshTokenDecoratorSelector>(
    data: unknown,
    selectors?: T
  ): Either<RefreshTokenValidationError, DecoratedAgentRefreshToken<T>> {
    return AgentRefreshTokenFactory.validateToken(data, selectors)
  }

  private static validateToken(
    data: unknown,
    selectors?: RefreshTokenDecoratorSelector
  ): Either<RefreshTokenValidationError, AgentRefreshToken | (AgentRefreshToken & {readonly occ: bigint})> {
    const validated = validateToken(data, validateAgentIdentity)
    if (E.isLeft(validated)) return validated
    const token = validated.right
    if (selectors?.occ !== true) return right(token)
    const occ = validateOcc(data)
    if (E.isLeft(occ)) return occ
    return right({...token, occ: occ.right})
  }

  static markAsUsed(
    token: AgentRefreshToken,
    nextTokenId: string,
    usedAt = new Date()
  ): Either<RefreshTokenValidationError, UsedAgentRefreshToken> {
    return markTokenAsUsed(token, nextTokenId, candidate => AgentRefreshTokenFactory.validate(candidate), usedAt)
  }
}

/** Returns true when a used token is still inside the bounded reuse grace period. */
export function isWithinGracePeriod(token: RefreshToken, time: Date): boolean {
  if (token.status !== RefreshTokenStatus.USED) return false

  const gracePeriodMs = GRACE_PERIOD_SECONDS * 1000
  const timeSinceUse = time.getTime() - token.usedAt.getTime()

  return timeSinceUse <= gracePeriodMs
}

/** Returns true when the token expiration time has passed. */
export function isExpired(token: RefreshToken, time: Date): boolean {
  return token.expiresAt < time
}

export type RefreshTokenEligibilityError =
  "refresh_token_expired" | "refresh_token_revoked" | "refresh_token_reuse_detected"

/**
 * Applies expiry, family-revocation, and bounded token-reuse checks before a
 * refresh rotation.
 *
 * The grace interval admits a concurrent retry from the same client while
 * preserving reuse detection after that interval. This removes the need for
 * callers to coordinate parallel refresh requests themselves.
 */
export function canTokenBeRefreshed(token: RefreshToken, time: Date): Either<RefreshTokenEligibilityError, true> {
  if (isExpired(token, time)) return left("refresh_token_expired")
  if (token.status === RefreshTokenStatus.REVOKED) return left("refresh_token_revoked")
  if (token.status === RefreshTokenStatus.USED)
    if (!isWithinGracePeriod(token, time))
      // Within grace period - return the next token
      // This is can be a possible race condition or someone that is trying to abuse the system.
      // Since the token was already used but we are outside the grace period,
      // the caller can not get anymore refreshed token
      return left("refresh_token_reuse_detected")

  // This is a race condition - the token was already used but since we are still inside the grace
  // period we allow the caller to still obtain a new token. This is a relaxation of the
  // strictness of the refresh token system to remove reduce the overhead of the caller logic
  // in case multiple requests are made in quick succession

  return right(true)
}

export function isDecoratedRefreshToken<K extends keyof RefreshTokenDecorators>(
  token: DecoratedRefreshToken<RefreshTokenDecoratorSelector>,
  key: K,
  options?: RefreshTokenDecoratorSelector
): token is DecoratedRefreshToken<RefreshTokenDecoratorSelector & Record<K, true>> {
  return isDecoratedWith<
    DecoratedRefreshToken<RefreshTokenDecoratorSelector>,
    RefreshTokenDecorators,
    RefreshTokenDecoratorSelector,
    keyof RefreshTokenDecorators
  >(token, key, options)
}
