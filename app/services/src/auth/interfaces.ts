import {
  AgentChallenge,
  AgentChallengeCreationError,
  AgentChallengeDecoratedValidationError,
  AgentChallengeEncryptionError,
  AgentChallengeJwtValidationError,
  AgentChallengeProcessingError,
  AgentChallengeValidationError,
  DecoratedAgentChallenge,
  RefreshToken,
  DecoratedRefreshToken,
  RefreshTokenValidationError,
  RefreshTokenEligibilityError,
  UsedUserRefreshToken,
  DecoratedActiveUserRefreshToken,
  UsedAgentRefreshToken,
  DecoratedActiveAgentRefreshToken,
  StepUpOperation
} from "@domain"
import {AgentGetError} from "../agent/interfaces"
import {AutoRegisterError} from "../user/user.service"
import {UserGetError} from "../user/interfaces"
import {OrganizationAdminCreateError} from "../organization-admin/interfaces"
import {UnknownError} from "../error"
import {PrefixUnion} from "@utils/types"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {DpopValidationError} from "@utils/dpop"

export const PKCE_SESSION_REPOSITORY_TOKEN = "PKCE_SESSION_REPOSITORY_TOKEN"
export const OIDC_PROVIDER_TOKEN = "OIDC_PROVIDER_TOKEN"
export const AGENT_CHALLENGE_REPOSITORY_TOKEN = "AGENT_CHALLENGE_REPOSITORY_TOKEN"
export const REFRESH_TOKEN_REPOSITORY_TOKEN = "REFRESH_TOKEN_REPOSITORY_TOKEN"
export const STEP_UP_TOKEN_REPOSITORY_TOKEN = "STEP_UP_TOKEN_REPOSITORY_TOKEN"

export type AuthError =
  | PrefixUnion<
      "auth",
      "token_generation_failed" | "authorization_url_generation_failed" | "missing_email_from_oidc_provider"
    >
  | UserGetError
  | AutoRegisterError
  | OrganizationAdminCreateError
  | OidcError
  | PkceError

export type HighPrivilegeAuthError = AuthError | PrefixUnion<"auth", "invalid_entity" | "high_privilege_flow_disabled">

export type UseHighPrivilegeTokenError =
  | "entity_not_supported"
  | "step_up_context_missing"
  | "step_up_operation_mismatch"
  | "step_up_resource_mismatch"
  | ConsumeTokenError
  | UnknownError

export type PkceError = PrefixUnion<
  "pkce",
  | "code_generation_failed"
  | "code_storage_failed"
  | "code_verification_failed"
  | "code_not_found"
  | "code_expired"
  | "code_already_used"
  | "code_concurrency_conflict"
>

export interface PkceChallenge {
  codeChallenge: string
  codeVerifier: string
  state: string
}

export interface PkceData {
  codeVerifier: string
  redirectUri: string
  oidcState: string
}

export interface PkceStorageData extends PkceData {
  expiresAt: Date
}

export interface PkceSessionData extends PkceStorageData {
  state: string
  occ: bigint
  usedAt?: Date
}

export interface PkceSessionRepository {
  storePkceData(state: string, data: PkceStorageData): TaskEither<PkceError, void>
  retrievePkceData(state: string): TaskEither<PkceError, PkceSessionData>
  deletePkceData(state: string): TaskEither<PkceError, void>
  updatePkceSession(sessionData: PkceSessionData, occCheck: bigint): TaskEither<PkceError, void>
}

export type OidcError = PrefixUnion<
  "oidc",
  | "token_exchange_failed"
  | "userinfo_fetch_failed"
  | "invalid_provider_response"
  | "network_error"
  | "invalid_token_response"
  | "invalid_userinfo_response"
  | UnknownError
>

export interface OidcTokenResponse {
  access_token: string
  /** OAuth 2.0 token type (typically "Bearer"), indicates how the access_token should be used */
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  /** OpenID Connect ID Token — a signed JWT containing user identity claims (sub, auth_time, etc.). Only returned when "openid" scope is requested. */
  id_token?: string
}

export interface OidcUserInfo {
  /** Subject identifier - REQUIRED by OpenID Connect spec */
  readonly sub: string
  /** Full name of user*/
  readonly name?: string
  /** Email address*/
  readonly email?: string
  /** Whether email has been verified*/
  readonly email_verified?: boolean
  /** Preferred username*/
  readonly preferred_username?: string
  /** Given name (first name)*/
  readonly given_name?: string
  /** Family name (surname)*/
  readonly family_name?: string
}

export interface OidcTokenRequest {
  grant_type: "authorization_code"
  code: string
  redirect_uri: string
  code_verifier: string
}

export type AgentChallengeGetError = "agent_challenge_not_found" | UnknownError
export type AgentChallengeUpdateError =
  | "agent_challenge_update_failed"
  | "agent_challenge_concurrent_update"
  | UnknownError

export type AgentTokenError =
  | "agent_token_generation_failed"
  | AgentGetError
  | AgentChallengeGetError
  | AgentChallengeJwtValidationError
  | AgentChallengeProcessingError
  | AgentChallengeUpdateError
  | GetChallengeByNonceError
  | UnknownError

export type AgentChallengeCreateError =
  | "agent_challenge_storage_error"
  | AgentChallengeCreationError
  | AgentChallengeValidationError
  | AgentChallengeEncryptionError
  | AgentGetError
  | UnknownError

export enum AssuranceLevel {
  NONE = "NONE",
  FORCE_LOGIN = "FORCE_LOGIN"
}

export interface OidcProvider {
  exchangeCodeForTokens(request: OidcTokenRequest): TaskEither<OidcError, OidcTokenResponse>
  getUserInfo(accessToken: string): TaskEither<OidcError, OidcUserInfo>
  /**
   * Generate a redirect URL to the IDP provider to obtain a token with the requested level of assurance
   */
  getAuthorizationUrl(pkce: PkceChallenge, assuranceLevel: AssuranceLevel): TaskEither<OidcError, string>
  /**
   * Validates the assurance level of the provided token
   */
  verifyAssuranceLevel(idToken: string, assuranceLevel: AssuranceLevel): TaskEither<OidcError, void>
}

export type GetChallengeByNonceError =
  | "agent_challenge_not_found"
  | AgentChallengeDecoratedValidationError
  | UnknownError

export interface AgentChallengeRepository {
  persistChallenge(challenge: AgentChallenge): TaskEither<AgentChallengeCreateError, AgentChallenge>
  getChallengeByNonce(nonce: string): TaskEither<GetChallengeByNonceError, DecoratedAgentChallenge<{occ: true}>>
  updateChallenge(challenge: DecoratedAgentChallenge<{occ: true}>): TaskEither<AgentChallengeUpdateError, void>
}

export type RefreshTokenCreateError = RefreshTokenValidationError | UnknownError
export type RefreshTokenGetError = "refresh_token_not_found" | RefreshTokenValidationError | UnknownError
export type RefreshTokenUpdateError = "refresh_token_concurrent_update" | RefreshTokenValidationError | UnknownError
export type RefreshTokenRevokeError = RefreshTokenValidationError | UnknownError

export type RefreshTokenRefreshError =
  | "refresh_token_not_found"
  | "refresh_token_entity_mismatch"
  | "refresh_token_concurrent_update"
  | DpopValidationError
  | AgentTokenError
  | RefreshTokenEligibilityError
  | AuthError
  | RefreshTokenValidationError
  | UnknownError

export interface RefreshTokenRepository {
  /**
   * Creates and persists a new refresh token in the repository.
   *
   * @param token - The refresh token domain object to create
   * @returns TaskEither with RefreshTokenCreateError on failure, or the created RefreshToken on success
   */
  createToken(token: RefreshToken): TaskEither<RefreshTokenCreateError, RefreshToken>

  /**
   * Retrieves a refresh token by its SHA-256 hash.
   *
   * @param tokenHash - The SHA-256 hash of the refresh token value
   * @returns TaskEither with RefreshTokenGetError on failure, or the decorated refresh token with OCC on success
   */
  getByTokenHash(tokenHash: string): TaskEither<RefreshTokenGetError, DecoratedRefreshToken<{occ: true}>>

  /**
   * Atomically creates a new active refresh token for a user and marks the old token as used.
   * Uses optimistic concurrency control to ensure the old token hasn't been modified.
   *
   * @param newTokenToPersist - The new active refresh token to create
   * @param oldTokenToUpdate - The old token to mark as used and link to the new token
   * @param occCheckOldToken - The expected OCC value of the old token for concurrency control
   * @returns TaskEither with RefreshTokenUpdateError on failure, or void on success
   */
  persistNewTokenUpdateOldForUser(
    newTokenToPersist: DecoratedActiveUserRefreshToken<{occ: true}>,
    oldTokenToUpdate: UsedUserRefreshToken,
    occCheckOldToken: bigint
  ): TaskEither<RefreshTokenUpdateError, void>

  /**
   * Atomically creates a new active refresh token for an agent and marks the old token as used.
   * Uses optimistic concurrency control to ensure the old token hasn't been modified.
   *
   * @param newTokenToPersist - The new active refresh token to create
   * @param oldTokenToUpdate - The old token to mark as used and link to the new token
   * @param occCheckOldToken - The expected OCC value of the old token for concurrency control
   * @returns TaskEither with RefreshTokenUpdateError on failure, or void on success
   */
  persistNewTokenUpdateOldForAgent(
    newTokenToPersist: DecoratedActiveAgentRefreshToken<{occ: true}>,
    oldTokenToUpdate: UsedAgentRefreshToken,
    occCheckOldToken: bigint
  ): TaskEither<RefreshTokenUpdateError, void>

  /**
   * Revokes all refresh tokens in a family by marking them as revoked.
   *
   * @param familyId - The family identifier of tokens to revoke
   * @returns TaskEither with RefreshTokenUpdateError on failure, or void on success
   */
  revokeFamily(familyId: string): TaskEither<RefreshTokenUpdateError, void>
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

export type StoreTokenError = UnknownError
export type ConsumeTokenError = UnknownError | "token_not_found"

export interface StepUpTokenRepository {
  /** Stores a token JTI with TTL for auto-expiry */
  storeToken(jti: string, ttlSeconds: number): TaskEither<StoreTokenError, void>
  /** Atomically deletes a token JTI. Fails if JTI doesn't exist (invalid or already consumed). */
  consumeToken(jti: string): TaskEither<ConsumeTokenError, void>
}

export interface PrivilegeTokenExchange {
  readonly code: string
  readonly state: string
  readonly operation: StepUpOperation
  readonly resourceId?: string
}
