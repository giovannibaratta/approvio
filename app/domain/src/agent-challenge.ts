import * as E from "fp-ts/Either"
import {Either, left, right} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {constants, publicEncrypt, randomBytes, randomUUID, verify} from "crypto"
import {isUUIDv4, PrefixUnion, DecorableEntity, isDecoratedWith, DynamicDecorators} from "@utils"
import {Agent} from "./agent"

export const CHALLENGE_EXPIRY_MINUTES = 10
export const NONCE_LENGTH = 32

export type AgentChallenge = Readonly<AgentChallengeData>
export type AgentChallengeCreate = Readonly<AgentChallengeCreateData>

interface AgentChallengeData {
  id: string
  agentName: string
  nonce: string
  expiresAt: Date
  usedAt?: Date
  createdAt: Date
}

interface AgentChallengeCreateData {
  agentName: string
}

export type ServerChallengePayload = Readonly<PrivateChallengePayload>

interface PrivateChallengePayload {
  audience: string
  expiresAt: Date
  issuer: string
  nonce: string
}

export type JwtAssertionPayload = Readonly<JwtAssertionClaims>

interface JwtAssertionClaims {
  iss: string // Issuer - agent name
  sub: string // Subject - agent name (same as iss for client authentication)
  aud: string // Audience - authorization server identifier
  exp: number // Expiration time - Unix timestamp
  jti: string // JWT ID - unique nonce from challenge
  iat?: number // Issued at time - Unix timestamp (optional)
  nbf?: number // Not before time - Unix timestamp (optional)
}

type IdValidationError = PrefixUnion<"agent_challenge", "invalid_uuid">
type AgentNameValidationError = PrefixUnion<"agent_challenge", "agent_name_empty" | "agent_name_invalid">
type NonceValidationError = PrefixUnion<"agent_challenge", "nonce_empty" | "nonce_invalid_length">
type ExpirationValidationError = PrefixUnion<"agent_challenge", "challenge_expired" | "challenge_already_used">
type NonceGenerationError = PrefixUnion<"agent_challenge", "nonce_generation_failed">
type DateValidationError = PrefixUnion<"agent_challenge", "expire_before_creation" | "used_at_before_creation">
type OccValidationError = PrefixUnion<"agent_challenge", "invalid_occ">
type EncryptionError = PrefixUnion<"agent_challenge", "encryption_failed">
type JwtValidationError = PrefixUnion<
  "agent_challenge",
  | "invalid_jwt_format"
  | "invalid_jwt_signature"
  | "jwt_expired"
  | "jwt_not_yet_valid"
  | "missing_required_claim"
  | "invalid_claim_value"
>
type ChallengeProcessingError = PrefixUnion<
  "agent_challenge",
  | "decryption_failed"
  | "invalid_challenge_format"
  | "nonce_mismatch"
  | "invalid_audience"
  | "invalid_issuer"
  | "invalid_agent_ownership"
  | "challenge_expired"
  | "challenge_already_used"
>

export type AgentChallengeCreateValidationError = AgentNameValidationError
export type AgentChallengeCreationError = AgentNameValidationError | NonceGenerationError
export type AgentChallengeUseError = ExpirationValidationError
export type AgentChallengeEncryptionError = EncryptionError
export type AgentChallengeJwtValidationError = JwtValidationError
export type AgentChallengeProcessingError = ChallengeProcessingError

export type AgentChallengeValidationError =
  | IdValidationError
  | AgentNameValidationError
  | NonceValidationError
  | ExpirationValidationError
  | OccValidationError
  | DateValidationError

export type AgentChallengeDecoratedValidationError = AgentChallengeValidationError | OccValidationError

export class AgentChallengeFactory {
  /**
   * Creates and validates a new agent challenge
   * @param data The challenge creation data
   * @returns Either validation/creation error or created challenge
   */
  static create(
    data: AgentChallengeCreateData
  ): Either<AgentChallengeCreationError | AgentChallengeValidationError, AgentChallenge> {
    const now = new Date()
    const createdAt = now
    const expiresAt = new Date(createdAt.getTime() + CHALLENGE_EXPIRY_MINUTES * 60 * 1000)

    return pipe(
      E.Do,
      E.bindW("nonce", () => this.generateNonce()),
      E.bindW("challenge", ({nonce}) => {
        return E.right({
          id: randomUUID(),
          agentName: data.agentName,
          nonce,
          createdAt,
          expiresAt
        })
      }),
      E.chainW(({challenge}) => this.validate(challenge, {}))
    )
  }

  /**
   * Creates a challenge payload to be encrypted and sent to agent
   * @param challenge The challenge entity
   * @param agentName The agent name (audience)
   * @param issuer The issuer name (e.g., "Approvio")
   * @returns Challenge payload object
   */
  private static createServerChallengePayload(
    challenge: AgentChallenge,
    agentName: string,
    issuer: string
  ): ServerChallengePayload {
    return {
      audience: agentName,
      expiresAt: challenge.expiresAt,
      issuer,
      nonce: challenge.nonce
    }
  }

  /**
   * Creates and encrypts a challenge payload for agent
   * @param challenge The challenge entity
   * @param agent The agent entity containing publicKey
   * @param issuer The issuer name (e.g., "Approvio")
   * @returns Either encryption error or encrypted challenge string
   */
  static createAndEncryptServerChallengePayload(
    challenge: AgentChallenge,
    agent: Agent,
    issuer: string
  ): Either<AgentChallengeEncryptionError, string> {
    try {
      const challengePayload = this.createServerChallengePayload(challenge, agent.agentName, issuer)
      const jsonPayload = JSON.stringify(challengePayload)
      const encrypted = publicEncrypt(
        {
          key: agent.publicKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256"
        },
        Buffer.from(jsonPayload, "utf8")
      )
      return right(encrypted.toString("base64"))
    } catch {
      return left("agent_challenge_encryption_failed" as const)
    }
  }

  /**
   * Validates and extracts JWT assertion payload according to RFC 7523
   * @param jwtAssertion The JWT assertion string
   * @param agent The agent entity containing publicKey for signature verification
   * @param expectedAudience The expected audience (authorization server identifier)
   * @returns Either JWT validation error or validated JWT payload with agent name
   */
  static validateJwtAssertion(
    jwtAssertion: string,
    agent: Agent,
    expectedAudience: string
  ): Either<AgentChallengeJwtValidationError, JwtAssertionPayload> {
    return pipe(
      E.Do,
      E.bindW("parsedJwt", () => this.parseJwt(jwtAssertion)),
      E.bindW("verifiedPayload", ({parsedJwt}) => this.verifyJwtSignature(parsedJwt, agent)),
      E.chainW(({verifiedPayload}) => this.validateJwtClaims(verifiedPayload, agent.agentName, expectedAudience))
    )
  }

  /**
   * Extracts agent name from JWT assertion without full validation
   * Used for agent lookup before signature verification
   * @param jwtAssertion The JWT assertion string
   * @returns Either parsing error or agent name from issuer claim
   */
  static extractAgentNameFromJwt(jwtAssertion: string): Either<AgentChallengeJwtValidationError, string> {
    return pipe(
      this.parseJwt(jwtAssertion),
      E.chainW(({payload}) => {
        if (typeof payload.iss !== "string" || !payload.iss.trim())
          return left("agent_challenge_missing_required_claim" as const)
        return right(payload.iss)
      })
    )
  }

  /**
   * Validates a decorated agent challenge entity with decorator-specific validation
   * @param data The decorated challenge data to validate
   * @param decorators The decorator configuration for additional validation
   * @returns Either validation error or validated decorated challenge
   */
  static validate<T extends AgentChallengeDecoratorSelector>(
    data: DecoratedAgentChallenge<T>,
    decorators: T
  ): Either<AgentChallengeDecoratedValidationError, DecoratedAgentChallenge<T>> {
    return pipe(
      E.Do,
      E.bindW("challengeId", () => this.validateChallengeId(data.id)),
      E.bindW("agentName", () => this.validateAgentName(data.agentName)),
      E.bindW("nonce", () => this.validateNonce(data.nonce)),
      E.bindW("dates", () => this.validateAgentChallengeDates(data)),
      E.bindW("decoratorValidation", () => this.validateDecorators(data, decorators)),
      E.map(({challengeId, agentName, nonce, dates, decoratorValidation}) => {
        const validated = {
          id: challengeId,
          agentName,
          nonce,
          ...dates,
          ...decoratorValidation
        }
        return validated
      })
    )
  }

  private static validateAgentChallengeDates(
    data: Pick<AgentChallengeData, "createdAt" | "expiresAt" | "usedAt">
  ): Either<DateValidationError, Pick<AgentChallengeData, "createdAt" | "expiresAt" | "usedAt">> {
    if (data.expiresAt <= data.createdAt) return left("agent_challenge_expire_before_creation" as const)
    if (data.usedAt && data.usedAt <= data.createdAt) return left("agent_challenge_used_at_before_creation" as const)

    return right(data)
  }

  /**
   * Marks a decorated challenge as used if it's valid and not expired
   * @param challenge The decorated challenge to mark as used
   * @param decorators The decorator selector configuration
   * @returns Either use error or updated decorated challenge
   */
  static markAsUsed<T extends AgentChallengeDecoratorSelector>(
    challenge: DecoratedAgentChallenge<T>,
    decorators: T
  ): Either<AgentChallengeUseError | AgentChallengeDecoratedValidationError, DecoratedAgentChallenge<T>> {
    const now = new Date()

    if (challenge.usedAt) return left("agent_challenge_challenge_already_used" as const)
    if (now > challenge.expiresAt) return left("agent_challenge_challenge_expired" as const)

    const updatedChallenge: DecoratedAgentChallenge<T> = {
      ...challenge,
      usedAt: now
    }

    return AgentChallengeFactory.validate(updatedChallenge, decorators)
  }

  /**
   * Validates a JWT assertion against the stored truth challenge
   * @param jwtPayload The validated JWT assertion payload
   * @param truthChallenge The stored challenge from database
   * @returns Either processing error or success
   */
  static validateJwtAssertionAgainstTruth(
    jwtPayload: JwtAssertionPayload,
    truthChallenge: AgentChallenge
  ): Either<AgentChallengeProcessingError, true> {
    const now = new Date()

    // Validate JWT ID (jti) matches the challenge nonce
    if (jwtPayload.jti !== truthChallenge.nonce) return left("agent_challenge_nonce_mismatch")

    // Validate issuer matches the challenge agent
    if (jwtPayload.iss !== truthChallenge.agentName) return left("agent_challenge_invalid_issuer")

    // Validate challenge hasn't expired
    if (now > truthChallenge.expiresAt) return left("agent_challenge_challenge_expired")

    // Validate challenge hasn't been used
    if (truthChallenge.usedAt) return left("agent_challenge_challenge_already_used")

    return right(true)
  }

  /**
   * Generates a cryptographically secure random nonce
   * @returns Either generation error or nonce string
   */
  private static generateNonce(): Either<NonceGenerationError, string> {
    try {
      const nonce = randomBytes(NONCE_LENGTH).toString("hex")
      return right(nonce)
    } catch {
      return left("agent_challenge_nonce_generation_failed")
    }
  }

  private static validateChallengeId(id: string): Either<IdValidationError, string> {
    if (!isUUIDv4(id)) return left("agent_challenge_invalid_uuid")
    return right(id)
  }

  private static validateAgentName(agentName: string): Either<AgentNameValidationError, string> {
    if (!agentName || agentName.trim().length === 0) return left("agent_challenge_agent_name_empty")

    return right(agentName)
  }

  private static validateNonce(nonce: string): Either<NonceValidationError, string> {
    if (!nonce || nonce.trim().length === 0) return left("agent_challenge_nonce_empty")
    if (nonce.length !== NONCE_LENGTH * 2)
      // hex encoding doubles the length
      return left("agent_challenge_nonce_invalid_length")

    return right(nonce)
  }

  private static validateDecorators<T extends AgentChallengeDecoratorSelector>(
    data: DecoratedAgentChallenge<T>,
    decorators: T
  ): Either<OccValidationError, DynamicDecorators<AgentChallengeDecorators, T>> {
    if (decorators.occ === true) {
      const occValidation = this.validateOcc((data as DecoratedAgentChallenge<{occ: true}>).occ)
      if (E.isLeft(occValidation)) return occValidation
    }
    return right(data)
  }

  private static validateOcc(occ: bigint): Either<OccValidationError, bigint> {
    return right(occ)
  }

  /**
   * Parses a JWT string into header, payload, and signature components
   * @param jwtString The JWT assertion string
   * @returns Either parsing error or parsed JWT components
   */
  private static parseJwt(jwtString: string): Either<
    AgentChallengeJwtValidationError,
    {
      header: Record<string, unknown>
      payload: Record<string, unknown>
      signature: string
      rawPayload: string
      rawSignature: string
    }
  > {
    try {
      const parts = jwtString.split(".")
      if (parts.length !== 3) {
        return left("agent_challenge_invalid_jwt_format" as const)
      }

      const headerB64 = parts[0]
      const payloadB64 = parts[1]
      const signatureB64 = parts[2]

      if (!headerB64 || !payloadB64 || !signatureB64) {
        return left("agent_challenge_invalid_jwt_format" as const)
      }

      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"))
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"))

      return right({
        header,
        payload,
        signature: signatureB64,
        rawPayload: `${headerB64}.${payloadB64}`,
        rawSignature: signatureB64
      })
    } catch {
      return left("agent_challenge_invalid_jwt_format" as const)
    }
  }

  /**
   * Verifies JWT signature using agent's public key
   * @param parsedJwt The parsed JWT components
   * @param agent The agent containing the public key
   * @returns Either signature verification error or verified payload
   */
  private static verifyJwtSignature(
    parsedJwt: {
      header: Record<string, unknown>
      payload: Record<string, unknown>
      rawPayload: string
      rawSignature: string
    },
    agent: Agent
  ): Either<AgentChallengeJwtValidationError, Record<string, unknown>> {
    try {
      const algorithm = parsedJwt.header.alg

      // Verify algorithm is RS256 (required by RFC 7523)
      if (algorithm !== "RS256") {
        return left("agent_challenge_invalid_jwt_signature" as const)
      }

      const signature = Buffer.from(parsedJwt.rawSignature, "base64url")
      const data = Buffer.from(parsedJwt.rawPayload, "utf8")

      const isValid = verify("RSA-SHA256", data, agent.publicKey, signature)

      if (!isValid) {
        return left("agent_challenge_invalid_jwt_signature" as const)
      }

      return right(parsedJwt.payload)
    } catch {
      return left("agent_challenge_invalid_jwt_signature" as const)
    }
  }

  /**
   * Validates JWT claims according to RFC 7523 requirements
   * @param payload The verified JWT payload
   * @param expectedIssuer The expected issuer (agent name)
   * @param expectedAudience The expected audience (authorization server)
   * @returns Either claims validation error or validated claims
   */
  private static validateJwtClaims(
    payload: Record<string, unknown>,
    expectedIssuer: string,
    expectedAudience: string
  ): Either<AgentChallengeJwtValidationError, JwtAssertionPayload> {
    const now = Math.floor(Date.now() / 1000)

    // Required claims validation
    if (typeof payload.iss !== "string") {
      return left("agent_challenge_missing_required_claim" as const)
    }
    if (typeof payload.sub !== "string") {
      return left("agent_challenge_missing_required_claim" as const)
    }
    if (typeof payload.aud !== "string") {
      return left("agent_challenge_missing_required_claim" as const)
    }
    if (typeof payload.exp !== "number") {
      return left("agent_challenge_missing_required_claim" as const)
    }
    if (typeof payload.jti !== "string") {
      return left("agent_challenge_missing_required_claim" as const)
    }

    // Validate claim values
    if (payload.iss !== expectedIssuer) {
      return left("agent_challenge_invalid_claim_value" as const)
    }
    if (payload.sub !== expectedIssuer) {
      return left("agent_challenge_invalid_claim_value" as const)
    }
    if (payload.aud !== expectedAudience) {
      return left("agent_challenge_invalid_claim_value" as const)
    }

    // Validate expiration
    if (payload.exp <= now) {
      return left("agent_challenge_jwt_expired" as const)
    }

    // Validate not before (if present)
    if (typeof payload.nbf === "number" && payload.nbf > now) {
      return left("agent_challenge_jwt_not_yet_valid" as const)
    }

    return right({
      iss: payload.iss,
      sub: payload.sub,
      aud: payload.aud,
      exp: payload.exp,
      jti: payload.jti,
      iat: typeof payload.iat === "number" ? payload.iat : undefined,
      nbf: typeof payload.nbf === "number" ? payload.nbf : undefined
    })
  }
}

export interface AgentChallengeDecorators {
  occ: bigint
}

export type AgentChallengeDecoratorSelector = Partial<Record<keyof AgentChallengeDecorators, boolean>>

export type DecoratedAgentChallenge<T extends AgentChallengeDecoratorSelector> = DecorableEntity<
  AgentChallenge,
  AgentChallengeDecorators,
  T
>

export function isDecoratedAgentChallenge<K extends keyof AgentChallengeDecorators>(
  challenge: DecoratedAgentChallenge<AgentChallengeDecoratorSelector>,
  key: K,
  options?: AgentChallengeDecoratorSelector
): challenge is DecoratedAgentChallenge<AgentChallengeDecoratorSelector & Record<K, true>> {
  return isDecoratedWith<
    DecoratedAgentChallenge<AgentChallengeDecoratorSelector>,
    AgentChallengeDecorators,
    AgentChallengeDecoratorSelector,
    keyof AgentChallengeDecorators
  >(challenge, key, options)
}
