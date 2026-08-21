import {User, Agent, OrgRole, StepUpContext} from "@domain"

const CLOCK_SKEW_TOLERANCE_IN_SECONDS = 60

interface TokenPayloadCore {
  // Core JWT claims
  iss: string // Issuer - identifies who issued the token
  sub: string // Subject - user/agent ID
  aud: string[] // Audience - intended recipients/services
  nbf?: number // Not before - optional validity start time
  jti?: string // JWT ID - unique identifier for the token

  // Display name
  name: string

  // Step-up context
  operation?: string // The operation this token is bound to
  resource?: string // The resource ID this token is bound to
}

export interface UserTokenPayloadForSigning extends TokenPayloadCore {
  entityType: "user"
  // IANA registered claims
  email: string
  providerId: string
  orgRole?: OrgRole // Organizational role (admin/member)
}

export interface AgentTokenPayloadForSigning extends TokenPayloadCore {
  entityType: "agent"
}

export type TokenPayloadForSigning = UserTokenPayloadForSigning | AgentTokenPayloadForSigning

export type UserTokenPayload = UserTokenPayloadForSigning & {
  exp: number
  iat: number
}

export type AgentTokenPayload = AgentTokenPayloadForSigning & {
  exp: number
  iat: number
}

export type TokenPayload = UserTokenPayload | AgentTokenPayload

export class TokenPayloadValidator {
  /**
   * Validates that an payload conforms to the TokenPayload schema
   * @param payload The payload to validate
   * @returns true if payload is a valid TokenPayload
   */
  static isValidPayloadSchema(payload: unknown): payload is TokenPayload {
    if (typeof payload !== "object" || payload === null) return false

    const p = payload as Record<string, unknown>

    return (
      TokenPayloadValidator.hasCoreClaims(p) &&
      TokenPayloadValidator.hasIanaClaims(p) &&
      TokenPayloadValidator.hasCustomClaims(p) &&
      TokenPayloadValidator.isValidStepUpContext(p)
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
    if (p.entityType !== "user" && p.entityType !== "agent") return false

    // Entity-specific validation
    if (p.entityType === "user") {
      if (typeof p.email !== "string") return false
      if (typeof p.providerId !== "string" || !p.providerId) return false
      if (p.orgRole !== undefined && p.orgRole !== "admin" && p.orgRole !== "member") return false
      if (p.roles !== undefined && !Array.isArray(p.roles)) return false
    }

    if (p.entityType === "agent") if (p.providerId !== undefined) return false

    return true
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
  issuer: string
  audience: string[]
  orgRole?: OrgRole
  stepUpContext?: StepUpContext
}

export type CreateAgentTokenPayloadData = {
  entityType: "agent"
  sub: string
  displayName: string
  issuer: string
  audience: string[]
  stepUpContext?: StepUpContext
}

export type CreateTokenPayloadData = CreateUserTokenPayloadData | CreateAgentTokenPayloadData

/**
 * Helper class for building JWT-compliant token payloads
 */
export class TokenPayloadBuilder {
  static from(data: CreateUserTokenPayloadData): UserTokenPayloadForSigning
  static from(data: CreateAgentTokenPayloadData): AgentTokenPayloadForSigning
  static from(data: CreateTokenPayloadData): TokenPayloadForSigning {
    if (data.entityType === "user")
      return {
        iss: data.issuer,
        sub: data.sub,
        aud: data.audience,
        jti: data.stepUpContext?.jti,
        email: data.email,
        name: data.displayName,
        entityType: "user",
        providerId: data.providerId,
        // Custom claims
        ...(data.orgRole && {orgRole: data.orgRole}),
        // Step-up context
        ...(data.stepUpContext?.operation && {operation: data.stepUpContext.operation}),
        ...(data.stepUpContext?.resource && {resource: data.stepUpContext.resource})
      }

    return {
      iss: data.issuer,
      sub: data.sub,
      aud: data.audience,
      jti: data.stepUpContext?.jti,
      name: data.displayName,
      entityType: "agent",
      // Step-up context
      ...(data.stepUpContext?.operation && {operation: data.stepUpContext.operation}),
      ...(data.stepUpContext?.resource && {resource: data.stepUpContext.resource})
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
      providerId: string
      stepUpContext?: StepUpContext
    }
  ): UserTokenPayloadForSigning {
    return TokenPayloadBuilder.from({
      sub: user.id,
      entityType: "user",
      displayName: user.displayName,
      email: user.email,
      orgRole: user.orgRole,
      providerId: options.providerId,
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
      sub: agent.agentName,
      entityType: "agent",
      displayName: agent.agentName,
      // Agents don't have email
      issuer: options.issuer,
      audience: options.audience
    })
  }
}
