import {
  createSha256Hash,
  DecorableEntity,
  GeneratorSelector,
  getStringAsEnum,
  hasOwnProperty,
  isDecoratedWith,
  isUUIDv4,
  PrefixUnion
} from "@utils"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {randomUUID} from "node:crypto"
import {User} from "./user"
import {Agent} from "./agent"
import {EntityType} from "./entityType"

export enum RefreshTokenStatus {
  UNUSED = "unused",
  USED = "used",
  REVOKED = "revoked"
}

export type RefreshTokenValidationError = PrefixUnion<
  "refresh_token",
  | "expire_before_create"
  | "invalid_agent_id"
  | "invalid_created_at"
  | "invalid_dpop_jkt"
  | "invalid_entity_type"
  | "invalid_expires_at"
  | "invalid_family_id"
  | "invalid_id"
  | "invalid_next_token_id"
  | "invalid_status"
  | "invalid_structure"
  | "invalid_token_hash"
  | "invalid_used_at"
  | "invalid_user_id"
  | "missing_entity_id"
  | "missing_entity_type"
  | "used_before_create"
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

interface UserProps {
  readonly entityType: EntityType.USER
  readonly userId: string
}

interface AgentProps {
  readonly entityType: EntityType.AGENT
  readonly agentId: string
}

export interface UnusedStatusProps {
  readonly status: RefreshTokenStatus.UNUSED
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

export type DecoratedUnusedUserRefreshToken<T extends RefreshTokenDecoratorSelector> = DecoratedRefreshToken<T> &
  UnusedUserRefreshToken
export type DecoratedUnusedAgentRefreshToken<T extends RefreshTokenDecoratorSelector> = DecoratedRefreshToken<T> &
  UnusedAgentRefreshToken

export type RefreshToken = RefreshTokenBase & EntityProps & StatusProps

type StatusProps = UnusedStatusProps | UsedStatusProps | RevokedStatusProps
type EntityProps = UserProps | AgentProps

type AgentRefreshToken = RefreshToken & AgentProps
type UserRefreshToken = RefreshToken & UserProps
type UnusedUserRefreshToken = UserRefreshToken & UnusedStatusProps
type UnusedAgentRefreshToken = AgentRefreshToken & UnusedStatusProps
type UsedRefreshToken = RefreshToken & UsedStatusProps
type RevokedRefreshToken = RefreshToken & RevokedStatusProps
export type UsedUserRefreshToken = UsedRefreshToken & UserProps
export type UsedAgentRefreshToken = UsedRefreshToken & AgentProps

/**
 * Grace period for token reuse detection after the expiration date.
 * The grace period is used to handle possible race conditions when inside a single session, the
 * client attempts to refresh the same token in parallel in a short period of time. This will
 * remove responsibility from the client to handle the race condition.
 */
export const GRACE_PERIOD_SECONDS = 30
export const REFRESH_TOKEN_EXPIRY_DAYS = 30

export class RefreshTokenFactory {
  /**
   * Create a new refresh token for a user
   */
  static createForUser(
    user: User,
    familyId?: string
  ): E.Either<RefreshTokenValidationError, DecoratedUnusedUserRefreshToken<{occ: true}> & {tokenValue: string}> {
    const {tokenValue, ...tokenBaseProps} = RefreshTokenFactory.generateTokenBaseProps(familyId)

    const token: UnusedUserRefreshToken = {
      ...tokenBaseProps,
      entityType: EntityType.USER,
      userId: user.id,
      status: RefreshTokenStatus.UNUSED
    }

    return pipe(
      {...token, occ: 0n},
      RefreshTokenFactory.validate<{occ: true}>,
      E.map((t): DecoratedUnusedUserRefreshToken<{occ: true}> & {tokenValue: string} => {
        return {
          ...(t as DecoratedUnusedUserRefreshToken<{occ: true}>),
          tokenValue
        }
      })
    )
  }

  /**
   * Create a new agent refresh token
   */
  static createForAgent(
    agent: Agent,
    familyId?: string
  ): E.Either<RefreshTokenValidationError, DecoratedUnusedAgentRefreshToken<{occ: true}> & {tokenValue: string}> {
    const {tokenValue, ...tokenBaseProps} = RefreshTokenFactory.generateTokenBaseProps(familyId)

    const token: UnusedAgentRefreshToken = {
      ...tokenBaseProps,
      entityType: EntityType.AGENT,
      agentId: agent.id,
      status: RefreshTokenStatus.UNUSED
    }

    return pipe(
      {...token, occ: 0n},
      E.right,
      E.chainW(data => RefreshTokenFactory.validate(data, {occ: true})),
      E.map(t => {
        return {
          ...(t as DecoratedUnusedAgentRefreshToken<{occ: true}>),
          tokenValue
        }
      })
    )
  }

  private static generateTokenBaseProps(familyIdOverride?: string): {tokenValue: string} & RefreshTokenBase {
    const id = randomUUID()
    const familyId = familyIdOverride ?? randomUUID()
    const tokenValue = randomUUID()
    const tokenHash = createSha256Hash(tokenValue)
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000)

    return {
      createdAt: new Date(),
      expiresAt,
      familyId,
      id,
      tokenHash,
      tokenValue
    }
  }

  /**
   * Validate a refresh token
   */
  static validate<T extends RefreshTokenDecoratorSelector>(
    data: unknown,
    selectors?: T
  ): E.Either<RefreshTokenValidationError, DecoratedRefreshToken<T>> {
    if (typeof data !== "object" || data === null) return E.left("refresh_token_invalid_structure" as const)

    if (!hasOwnProperty(data, "id") || typeof data.id !== "string" || !isUUIDv4(data.id))
      return E.left("refresh_token_invalid_id")

    if (!hasOwnProperty(data, "familyId") || typeof data.familyId !== "string" || !isUUIDv4(data.familyId))
      return E.left("refresh_token_invalid_family_id")

    if (!hasOwnProperty(data, "tokenHash") || typeof data.tokenHash !== "string" || data.tokenHash.length === 0)
      return E.left("refresh_token_invalid_token_hash")

    if (!hasOwnProperty(data, "status") || typeof data.status !== "string")
      return E.left("refresh_token_invalid_status")

    const status = getStringAsEnum(data.status, RefreshTokenStatus)
    if (status === undefined) return E.left("refresh_token_invalid_status")

    if (!hasOwnProperty(data, "entityType") || typeof data.entityType !== "string")
      return E.left("refresh_token_missing_entity_type")

    const entityType = getStringAsEnum(data.entityType, EntityType)
    if (entityType === undefined) return E.left("refresh_token_invalid_entity_type")

    if (!hasOwnProperty(data, "expiresAt") || !(data.expiresAt instanceof Date))
      return E.left("refresh_token_invalid_expires_at")

    if (!hasOwnProperty(data, "createdAt") || !(data.createdAt instanceof Date))
      return E.left("refresh_token_invalid_created_at")

    if (data.expiresAt < data.createdAt) return E.left("refresh_token_expire_before_create")

    const base: RefreshTokenBase = {
      id: data.id,
      tokenHash: data.tokenHash,
      familyId: data.familyId,
      expiresAt: data.expiresAt,
      createdAt: data.createdAt
    }

    const eitherStatusProps = RefreshTokenFactory.validateStatusProps({
      ...data,
      ...base,
      status
    })

    const eitherEntityProps = RefreshTokenFactory.validateEntityProps({
      ...data,
      ...base,
      entityType
    })

    if (E.isLeft(eitherStatusProps)) return eitherStatusProps
    if (E.isLeft(eitherEntityProps)) return eitherEntityProps

    const undecorated: RefreshToken = {
      ...data,
      ...base,
      ...eitherStatusProps.right,
      ...eitherEntityProps.right
    }

    let occ: bigint | undefined = undefined
    if (selectors?.occ) {
      if (
        !isDecoratedRefreshToken(undecorated, "occ", {
          occ: true
        })
      )
        return E.left("refresh_token_missing_occ")
      occ = undecorated.occ
    }

    return E.right({
      ...undecorated,
      ...(occ !== undefined && {occ})
    })
  }

  private static validateStatusProps(
    data: unknown & RefreshTokenBase & {status: RefreshTokenStatus}
  ): E.Either<RefreshTokenValidationError, StatusProps> {
    let eitherStatusProps: E.Either<RefreshTokenValidationError, StatusProps>

    switch (data.status) {
      case RefreshTokenStatus.UNUSED:
        eitherStatusProps = RefreshTokenFactory.validateUnusedStatusProps({
          ...data,
          status: RefreshTokenStatus.UNUSED
        })
        break
      case RefreshTokenStatus.USED:
        eitherStatusProps = RefreshTokenFactory.validateUsedStatusProps({
          ...data,
          status: RefreshTokenStatus.USED
        })
        break
      case RefreshTokenStatus.REVOKED:
        eitherStatusProps = RefreshTokenFactory.validateRevokedStatusProps({
          ...data,
          status: RefreshTokenStatus.REVOKED
        })
        break
    }

    return eitherStatusProps
  }

  private static validateUnusedStatusProps(
    data: unknown & {status: RefreshTokenStatus.UNUSED}
  ): E.Either<RefreshTokenValidationError, UnusedStatusProps> {
    if (typeof data !== "object" || data === null) return E.left("refresh_token_invalid_structure" as const)

    return E.right({
      status: RefreshTokenStatus.UNUSED
    })
  }

  private static validateUsedStatusProps(
    data: unknown & RefreshTokenBase & {status: RefreshTokenStatus.USED}
  ): E.Either<RefreshTokenValidationError, UsedStatusProps> {
    if (typeof data !== "object" || data === null) return E.left("refresh_token_invalid_structure" as const)

    if (!hasOwnProperty(data, "usedAt") || !(data.usedAt instanceof Date))
      return E.left("refresh_token_invalid_used_at")

    if (data.usedAt < data.createdAt) return E.left("refresh_token_used_before_create")

    if (!hasOwnProperty(data, "nextTokenId") || typeof data.nextTokenId !== "string" || !isUUIDv4(data.nextTokenId))
      return E.left("refresh_token_invalid_next_token_id")

    return E.right({
      status: RefreshTokenStatus.USED,
      usedAt: data.usedAt,
      nextTokenId: data.nextTokenId
    })
  }

  private static validateRevokedStatusProps(
    data: unknown & {status: RefreshTokenStatus.REVOKED}
  ): E.Either<RefreshTokenValidationError, RevokedStatusProps> {
    if (typeof data !== "object" || data === null) return E.left("refresh_token_invalid_structure" as const)

    return E.right({
      status: RefreshTokenStatus.REVOKED
    })
  }

  private static validateEntityProps(
    data: unknown & RefreshTokenBase & {entityType: EntityType}
  ): E.Either<RefreshTokenValidationError, EntityProps> {
    let eitherEntityProps: E.Either<RefreshTokenValidationError, EntityProps>

    switch (data.entityType) {
      case EntityType.USER:
        eitherEntityProps = RefreshTokenFactory.validateUserEntityProps({
          ...data,
          entityType: EntityType.USER
        })
        break
      case EntityType.AGENT:
        eitherEntityProps = RefreshTokenFactory.validateAgentEntityProps({
          ...data,
          entityType: EntityType.AGENT
        })
        break
    }

    return eitherEntityProps
  }

  private static validateUserEntityProps(
    data: unknown & RefreshTokenBase & {entityType: EntityType.USER}
  ): E.Either<RefreshTokenValidationError, UserProps> {
    if (typeof data !== "object" || data === null) return E.left("refresh_token_invalid_structure" as const)

    if (!hasOwnProperty(data, "userId") || typeof data.userId !== "string" || !isUUIDv4(data.userId))
      return E.left("refresh_token_invalid_user_id")

    return E.right({
      entityType: EntityType.USER,
      userId: data.userId
    })
  }

  private static validateAgentEntityProps(
    data: unknown & RefreshTokenBase & {entityType: EntityType.AGENT}
  ): E.Either<RefreshTokenValidationError, AgentProps> {
    if (typeof data !== "object" || data === null) return E.left("refresh_token_invalid_structure" as const)

    if (!hasOwnProperty(data, "agentId") || typeof data.agentId !== "string" || !isUUIDv4(data.agentId))
      return E.left("refresh_token_invalid_agent_id")

    return E.right({
      entityType: EntityType.AGENT,
      agentId: data.agentId
    })
  }

  /**
   * Mark a token as used
   */
  static markAsUsed(token: RefreshToken, nextTokenId: string): E.Either<RefreshTokenValidationError, UsedRefreshToken> {
    const updatedToken: UsedRefreshToken = {
      ...token,
      status: RefreshTokenStatus.USED,
      usedAt: new Date(),
      nextTokenId
    }

    const validated = RefreshTokenFactory.validate(updatedToken)

    if (E.isLeft(validated)) return validated

    return E.right(updatedToken)
  }

  static markAsUsedForAgent(
    token: AgentRefreshToken,
    nextTokenId: string
  ): E.Either<RefreshTokenValidationError, UsedAgentRefreshToken> {
    const eitherUser = RefreshTokenFactory.markAsUsed(token, nextTokenId)

    if (E.isLeft(eitherUser)) return eitherUser

    return E.right(eitherUser.right as UsedAgentRefreshToken)
  }

  static markAsUsedForUser(
    token: UserRefreshToken,
    nextTokenId: string
  ): E.Either<RefreshTokenValidationError, UsedUserRefreshToken> {
    const eitherUser = RefreshTokenFactory.markAsUsed(token, nextTokenId)

    if (E.isLeft(eitherUser)) return eitherUser

    return E.right(eitherUser.right as UsedUserRefreshToken)
  }

  /**
   * Mark a token as revoked
   */
  static markAsRevoked(token: RefreshToken): E.Either<RefreshTokenValidationError, RevokedRefreshToken> {
    const updatedToken: RevokedRefreshToken = {
      ...token,
      status: RefreshTokenStatus.REVOKED
    }

    const validated = RefreshTokenFactory.validate(updatedToken)

    if (E.isLeft(validated)) return validated

    return E.right(updatedToken)
  }

  /**
   * Check if a token is within the grace period
   */
  static isWithinGracePeriod(token: RefreshToken, time: Date): boolean {
    if (token.status !== RefreshTokenStatus.USED) return false

    const gracePeriodMs = GRACE_PERIOD_SECONDS * 1000
    const timeSinceUse = time.getTime() - token.usedAt.getTime()

    return timeSinceUse <= gracePeriodMs
  }

  /**
   * Check if a token is expired
   */
  static isExpired(token: RefreshToken, time: Date): boolean {
    return token.expiresAt < time
  }

  static isUserToken(token: RefreshToken): token is RefreshToken & UserProps {
    return token.entityType === EntityType.USER
  }

  static isAgentToken(token: RefreshToken): token is RefreshToken & AgentProps {
    return token.entityType === EntityType.AGENT
  }
}

export type RefreshTokenEligibilityError =
  | "refresh_token_expired"
  | "refresh_token_revoked"
  | "refresh_token_reuse_detected"

export function canTokenBeRefreshed(token: RefreshToken, time: Date): E.Either<RefreshTokenEligibilityError, true> {
  if (RefreshTokenFactory.isExpired(token, time)) return E.left("refresh_token_expired" as const)
  if (token.status === RefreshTokenStatus.REVOKED) return E.left("refresh_token_revoked")
  if (token.status === RefreshTokenStatus.USED) {
    // Within grace period - return the next token
    if (!RefreshTokenFactory.isWithinGracePeriod(token, time)) {
      // This is can be a possible race condition or someone that is trying to abuse the system.
      // Since the token was already used but we are outside the grace period,
      // the caller can not get anymore refreshed token
      return E.left("refresh_token_reuse_detected" as const)
    }
    // This is a race condition - the token was already used but since we are still inside the grace
    // period we allow the caller to still obtain a new token. This is a relaxation of the
    // strictness of the refresh token system to remove reduce the overhead of the caller logic
    // in case multiple requests are made in quick succession
  }

  return E.right(true)
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
