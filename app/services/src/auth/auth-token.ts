import {Account, User, Agent, OrgRole, StepUpContext} from "@domain"
import {isObject, isUUIDv7} from "@utils"

const CLOCK_SKEW_TOLERANCE_IN_SECONDS = 60

interface TokenPayloadCore {
  // Core JWT claims
  iss: string // Issuer - identifies who issued the token
  sub: string // Subject - user/agent ID
  aud: string[] // Audience - intended recipients/services
  nbf?: number // Not before - optional validity start time
  jti?: string // JWT ID - optional identifier for this token

  // Display name
  name: string
}

export interface UserTokenPayloadForSigning extends TokenPayloadCore {
  entityType: "user"
  // IANA registered claims
  email: string
  providerId: string
  accountId: string
  sessionId: string
  /** Decimal string on the JWT wire */
  sessionContextVersion: string
  orgRole: OrgRole // Organizational role (owner/admin/member)
  operation?: string // The operation this token is bound to
  resource?: string // The resource ID this token is bound to
}

export interface AgentTokenPayloadForSigning extends TokenPayloadCore {
  entityType: "agent"
  organizationId: string
}

export interface PlatformTokenPayloadForSigning extends TokenPayloadCore {
  entityType: "platform"
  sessionId: string
  providerId: string
  /** Decimal string on the JWT wire */
  sessionContextVersion: string
}

export type TokenPayloadForSigning =
  UserTokenPayloadForSigning | AgentTokenPayloadForSigning | PlatformTokenPayloadForSigning

export type UserTokenPayload = UserTokenPayloadForSigning & {
  exp: number
  iat: number
}

export type AgentTokenPayload = AgentTokenPayloadForSigning & {
  exp: number
  iat: number
}

export type PlatformTokenPayload = PlatformTokenPayloadForSigning & {
  exp: number
  iat: number
}

export type TokenPayload = UserTokenPayload | AgentTokenPayload | PlatformTokenPayload

export class TokenPayloadValidator {
  /**
   * Validates that an payload conforms to the TokenPayload schema
   * @param payload The payload to validate
   * @returns true if payload is a valid TokenPayload
   */
  static isValidPayloadSchema(payload: unknown): payload is TokenPayload {
    if (!isObject(payload)) return false

    return (
      TokenPayloadValidator.hasCoreClaims(payload) &&
      TokenPayloadValidator.hasIanaClaims(payload) &&
      TokenPayloadValidator.hasCustomClaims(payload)
    )
  }

  private static hasCoreClaims(p: Record<string, unknown>): boolean {
    return (
      typeof p.iss === "string" &&
      typeof p.sub === "string" &&
      Array.isArray(p.aud) &&
      p.aud.every((aud: unknown) => typeof aud === "string") &&
      typeof p.exp === "number" &&
      typeof p.iat === "number" &&
      (p.nbf === undefined || typeof p.nbf === "number") &&
      (p.jti === undefined || typeof p.jti === "string")
    )
  }

  private static hasIanaClaims(p: Record<string, unknown>): boolean {
    return (p.email === undefined || typeof p.email === "string") && typeof p.name === "string"
  }

  private static hasCustomClaims(p: Record<string, unknown>): boolean {
    if (p.entityType === "user") return this.hasValidUserClaims(p)
    if (p.entityType === "agent") return typeof p.organizationId === "string" && isUUIDv7(p.organizationId)

    if (p.entityType === "platform") return this.hasValidPlatformClaims(p)

    return false
  }

  private static hasValidUserClaims(p: Record<string, unknown>): boolean {
    return (
      typeof p.email === "string" &&
      typeof p.providerId === "string" &&
      isUUIDv7(p.providerId) &&
      typeof p.accountId === "string" &&
      isUUIDv7(p.accountId) &&
      typeof p.sessionId === "string" &&
      isUUIDv7(p.sessionId) &&
      typeof p.sessionContextVersion === "string" &&
      /^\d+$/.test(p.sessionContextVersion) &&
      (p.orgRole === "owner" || p.orgRole === "admin" || p.orgRole === "member") &&
      this.isValidStepUpContext(p)
    )
  }

  private static hasValidPlatformClaims(p: Record<string, unknown>): boolean {
    return (
      typeof p.sessionId === "string" &&
      isUUIDv7(p.sessionId) &&
      typeof p.providerId === "string" &&
      isUUIDv7(p.providerId) &&
      typeof p.sessionContextVersion === "string" &&
      /^\d+$/.test(p.sessionContextVersion)
    )
  }

  private static isValidStepUpContext(p: Record<string, unknown>): boolean {
    return (
      (p.operation === undefined || typeof p.operation === "string") &&
      (p.resource === undefined || typeof p.resource === "string")
    )
  }

  /**
   * Validates token time-based claims
   * @param payload The token payload to validate
   * @param currentTime Current time in seconds since epoch (defaults to now)
   * @returns true if token is valid for the current time
   */
  static isValidTime(payload: TokenPayload, currentTime?: number): boolean {
    const now = currentTime ?? Math.floor(Date.now() / 1000)

    // Check expiration
    if (payload.exp <= now) return false

    // Check not before if present
    if (payload.nbf !== undefined && payload.nbf > now + CLOCK_SKEW_TOLERANCE_IN_SECONDS) return false

    // Check issued at (cannot be in the future beyond skew tolerance)
    if (payload.iat > now + CLOCK_SKEW_TOLERANCE_IN_SECONDS) return false

    return true
  }

  /**
   * Validates that token issuer is in the trusted issuers list
   * @param payload The token payload to validate
   * @param trustedIssuers List of trusted issuer identifiers
   * @returns true if issuer is trusted
   */
  static isValidIssuer(payload: TokenPayload, trustedIssuers: string[]): boolean {
    return trustedIssuers.includes(payload.iss)
  }

  /**
   * Validates that token audience matches the expected audience
   * @param payload The token payload to validate
   * @param expectedAudience The expected audience string
   * @returns true if audience matches
   */
  static isValidAudience(payload: TokenPayload, expectedAudience: string): boolean {
    return payload.aud.includes(expectedAudience)
  }
}

export type CreateUserTokenPayloadData = {
  entityType: "user"
  sub: string
  displayName: string
  email: string
  providerId: string
  accountId: string
  sessionId: string
  sessionContextVersion: bigint
  issuer: string
  audience: string[]
  orgRole: OrgRole
  stepUpContext?: StepUpContext
}

export type CreateAgentTokenPayloadData = {
  entityType: "agent"
  sub: string
  displayName: string
  organizationId: string
  issuer: string
  audience: string[]
}

export type CreatePlatformTokenPayloadData = {
  entityType: "platform"
  sub: string
  displayName: string
  sessionId: string
  providerId: string
  sessionContextVersion: bigint
  issuer: string
  audience: string[]
}

export type CreateTokenPayloadData =
  CreateUserTokenPayloadData | CreateAgentTokenPayloadData | CreatePlatformTokenPayloadData

/**
 * Helper class for building JWT-compliant token payloads
 */
export class TokenPayloadBuilder {
  static from(data: CreateUserTokenPayloadData): UserTokenPayloadForSigning
  static from(data: CreateAgentTokenPayloadData): AgentTokenPayloadForSigning
  static from(data: CreatePlatformTokenPayloadData): PlatformTokenPayloadForSigning
  static from(data: CreateTokenPayloadData): TokenPayloadForSigning {
    if (data.entityType === "user")
      return {
        iss: data.issuer,
        sub: data.sub,
        aud: data.audience,
        jti: data.stepUpContext?.jti,
        name: data.displayName,
        email: data.email,
        entityType: "user",
        providerId: data.providerId,
        accountId: data.accountId,
        sessionId: data.sessionId,
        sessionContextVersion: data.sessionContextVersion.toString(),
        // Custom claims
        orgRole: data.orgRole,
        // Step-up context
        ...(data.stepUpContext?.operation && {operation: data.stepUpContext.operation}),
        ...(data.stepUpContext?.resource && {resource: data.stepUpContext.resource})
      }

    if (data.entityType === "agent")
      return {
        iss: data.issuer,
        sub: data.sub,
        aud: data.audience,
        name: data.displayName,
        entityType: "agent",
        organizationId: data.organizationId
      }

    return {
      iss: data.issuer,
      sub: data.sub,
      aud: data.audience,
      name: data.displayName,
      entityType: "platform",
      sessionId: data.sessionId,
      providerId: data.providerId,
      sessionContextVersion: data.sessionContextVersion.toString()
    }
  }

  /**
   * Creates token payload data ready for JWT signing from a User domain object
   * @param user The User domain object
   * @param options Configuration for token generation
   * @returns A UserTokenPayloadForSigning
   */
  static fromUser(
    user: User,
    options: {
      issuer: string
      audience: string[]
      email: string
      providerId: string
      sessionId: string
      sessionContextVersion: bigint
      stepUpContext?: StepUpContext
    }
  ): UserTokenPayloadForSigning {
    return TokenPayloadBuilder.from({
      sub: user.id,
      entityType: "user",
      displayName: user.displayName,
      orgRole: user.orgRole,
      email: options.email,
      providerId: options.providerId,
      accountId: user.accountId,
      sessionId: options.sessionId,
      sessionContextVersion: options.sessionContextVersion,
      issuer: options.issuer,
      audience: options.audience,
      stepUpContext: options.stepUpContext
    })
  }

  /**
   * Creates token payload data ready for JWT signing from an Agent domain object
   * @param agent The Agent domain object
   * @param options Optional configuration for token generation
   * @returns An AgentTokenPayloadForSigning
   */
  static fromAgent(
    agent: Agent,
    options: {
      issuer: string
      audience: string[]
    }
  ): AgentTokenPayloadForSigning {
    return TokenPayloadBuilder.from({
      sub: agent.id,
      entityType: "agent",
      displayName: agent.agentName,
      organizationId: agent.organizationId,
      // Agents don't have email
      issuer: options.issuer,
      audience: options.audience
    })
  }

  static fromPlatformAccount(
    account: Account,
    options: {
      issuer: string
      audience: string[]
      sessionId: string
      providerId: string
      sessionContextVersion: bigint
    }
  ): PlatformTokenPayloadForSigning {
    return TokenPayloadBuilder.from({
      entityType: "platform",
      sub: account.id,
      displayName: account.displayName,
      issuer: options.issuer,
      audience: options.audience,
      sessionId: options.sessionId,
      providerId: options.providerId,
      sessionContextVersion: options.sessionContextVersion
    })
  }
}
