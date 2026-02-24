import {User, Agent, OrgRole, AuthenticatedEntity, StepUpContext} from "@domain"

const CLOCK_SKEW_TOLERANCE_IN_SECONDS = 60

export interface TokenPayloadForSigning {
  // Core JWT claims
  iss: string // Issuer - identifies who issued the token
  sub: string // Subject - user/agent ID
  aud: string[] // Audience - intended recipients/services
  nbf?: number // Not before - optional validity start time
  jti?: string // JWT ID - unique identifier for the token

  // IANA registered claims
  email?: string // User email (not applicable for agents)
  name: string // Display name (using standard 'name' claim)

  // Custom application claims
  entityType: AuthenticatedEntity["entityType"]
  orgRole?: OrgRole // Organizational role (admin/member) - only for users

  // Step-up context
  operation?: string // The operation this token is bound to
  resource?: string // The resource ID this token is bound to
}

export interface TokenPayload extends TokenPayloadForSigning {
  exp: number // Expiration time
  iat: number // Issued at time
}

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
      // Core JWT claims validation
      typeof p.iss === "string" &&
      typeof p.sub === "string" &&
      Array.isArray(p.aud) &&
      p.aud.every((aud: unknown) => typeof aud === "string") &&
      typeof p.exp === "number" &&
      typeof p.iat === "number" &&
      (p.nbf === undefined || typeof p.nbf === "number") &&
      (p.jti === undefined || typeof p.jti === "string") &&
      // IANA registered claims
      (p.email === undefined || typeof p.email === "string") &&
      typeof p.name === "string" &&
      // Custom application claims
      (p.entityType === "user" || p.entityType === "agent") &&
      // Entity-specific validation
      (p.entityType === "agent" || typeof p.email === "string") &&
      // Organization role validation (only for users)
      (p.entityType === "agent" || p.orgRole === undefined || p.orgRole === "admin" || p.orgRole === "member") &&
      // Roles validation (only for users, should be array if present)
      (p.entityType === "agent" || p.roles === undefined || Array.isArray(p.roles)) &&
      // Step-up context validation
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

    // Check if the token is already active
    if (payload.nbf !== undefined && payload.nbf > now) return false

    // Check issued-at is not in the future (with small tolerance for clock skew)
    if (payload.iat > now + CLOCK_SKEW_TOLERANCE_IN_SECONDS) return false

    return true
  }

  /**
   * Validates token issuer
   * @param payload The token payload to validate
   * @param trustedIssuers The trusted issuer value(s)
   * @returns true if issuer matches any trusted issuer
   */
  static isValidIssuer(payload: TokenPayload, trustedIssuers: string | string[]): boolean {
    const trusted = Array.isArray(trustedIssuers) ? trustedIssuers : [trustedIssuers]
    return trusted.includes(payload.iss)
  }

  /**
   * Validates token audience
   * @param payload The token payload to validate
   * @param expectedAudience The expected audience value(s)
   * @returns true if at least one audience matches
   */
  static isValidAudience(payload: TokenPayload, expectedAudience: string | string[]): boolean {
    const expected = Array.isArray(expectedAudience) ? expectedAudience : [expectedAudience]
    return expected.some(aud => payload.aud.includes(aud))
  }
}

/**
 * Helper class for building JWT-compliant token payloads
 */
export class TokenPayloadBuilder {
  /**
   * Creates token payload data ready for JWT signing from user/agent data
   * @param data The base data to create token from
   * @returns A TokenPayloadForSigning
   */
  static from(data: {
    sub: string
    entityType: AuthenticatedEntity["entityType"]
    displayName: string
    email?: string
    orgRole?: OrgRole
    issuer: string
    audience: string[]
    stepUpContext?: StepUpContext
  }): TokenPayloadForSigning {
    return {
      iss: data.issuer,
      sub: data.sub,
      aud: data.audience,
      jti: data.stepUpContext?.jti,

      // IANA registered claims
      email: data.email,
      name: data.displayName,

      // Custom application claims
      entityType: data.entityType,
      ...(data.entityType === "user" && data.orgRole && {orgRole: data.orgRole}),

      // Step-up context
      ...(data.stepUpContext?.operation && {operation: data.stepUpContext.operation}),
      ...(data.stepUpContext?.resource && {resource: data.stepUpContext.resource})
    }
  }

  /**
   * Creates token payload data ready for JWT signing from a User domain object
   * @param user The User domain object
   * @param options Optional configuration for token generation
   * @returns A TokenPayloadForSigning
   */
  static fromUser(
    user: User,
    options: {
      issuer: string
      audience: string[]
      stepUpContext?: StepUpContext
    }
  ): TokenPayloadForSigning {
    return TokenPayloadBuilder.from({
      sub: user.id,
      entityType: "user",
      displayName: user.displayName,
      email: user.email,
      orgRole: user.orgRole,
      issuer: options.issuer,
      audience: options.audience,
      stepUpContext: options.stepUpContext
    })
  }

  /**
   * Creates token payload data ready for JWT signing from an Agent domain object
   * @param agent The Agent domain object
   * @param options Optional configuration for token generation
   * @returns A TokenPayloadForSigning
   */
  static fromAgent(
    agent: Agent,
    options: {
      issuer: string
      audience: string[]
    }
  ): TokenPayloadForSigning {
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
