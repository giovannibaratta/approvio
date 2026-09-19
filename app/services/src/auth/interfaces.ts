// TODO: Renaming providerId to providerConnectionId doesn't seem to bring a lot of value.
import {
  AgentChallenge,
  AgentChallengeCreationError,
  AgentChallengeDecoratedValidationError,
  AgentChallengeEncryptionError,
  AgentChallengeJwtValidationError,
  AgentChallengeProcessingError,
  AgentChallengeValidationError,
  DecoratedAgentChallenge,
  AccountRefreshToken,
  AgentRefreshToken,
  DecoratedAccountRefreshToken,
  DecoratedAgentRefreshToken,
  RefreshTokenValidationError,
  RefreshTokenEligibilityError,
  UsedAccountRefreshToken,
  DecoratedActiveAccountRefreshToken,
  UsedAgentRefreshToken,
  DecoratedActiveAgentRefreshToken,
  StepUpOperation,
  AuthorityError,
  BoundaryError,
  TransactionError,
  TenantContext
} from "@domain"
import {AgentGetError} from "../agent/interfaces"
import {UnknownError, EncryptionError, RepositoryDependencyError} from "../error"
import {PrefixUnion} from "@utils/types"
import {TaskEither} from "fp-ts/TaskEither"
import {ExecutionError} from "@services/transaction/interfaces"
import {Either} from "fp-ts/Either"
import {DpopValidationError} from "@utils/dpop"

export const PKCE_SESSION_REPOSITORY_TOKEN = "PKCE_SESSION_REPOSITORY_TOKEN"
export const OIDC_PROVIDER_TOKEN = "OIDC_PROVIDER_TOKEN"
export const AGENT_CHALLENGE_REPOSITORY_TOKEN = "AGENT_CHALLENGE_REPOSITORY_TOKEN"
export const ACCOUNT_REFRESH_TOKEN_REPOSITORY_TOKEN = "ACCOUNT_REFRESH_TOKEN_REPOSITORY_TOKEN"
export const AGENT_REFRESH_TOKEN_REPOSITORY_TOKEN = "AGENT_REFRESH_TOKEN_REPOSITORY_TOKEN"
export const DPOP_TOKEN_REPOSITORY_TOKEN = "DPOP_TOKEN_REPOSITORY_TOKEN"

export type AuthError =
  | PrefixUnion<
      "auth",
      | "token_generation_failed"
      | "authorization_url_generation_failed"
      | "missing_email_from_oidc_provider"
      | "invalid_redirect_uri"
      | "identity_conflict"
      | "invalid_oidc_provider"
      | "missing_oidc_provider"
    >
  | BoundaryError
  | "account_not_found"
  | OidcError
  | PkceError

export type HighPrivilegeAuthError =
  | AuthError
  | AuthorityError
  | TransactionError
  | RepositoryDependencyError
  | PrefixUnion<"auth", "invalid_entity" | "high_privilege_flow_disabled">

export type UseHighPrivilegeTokenError =
  | "entity_not_supported"
  | "step_up_context_missing"
  | "step_up_operation_mismatch"
  | "step_up_resource_mismatch"
  | AuthorityError
  | TransactionError
  | RepositoryDependencyError
  | UnknownError

export type PkceError =
  | PrefixUnion<
      "pkce",
      | "code_generation_failed"
      | "code_storage_failed"
      | "code_verification_failed"
      | "code_not_found"
      | "code_expired"
      | "code_already_used"
      | "code_concurrency_conflict"
    >
  | EncryptionError

export interface PkceChallenge {
  codeChallenge: string
  codeVerifier: string
  state: string
}

export interface PkceData {
  codeVerifier: string
  redirectUri: string
  oidcState: string
  providerConnectionId: string
  // TOOD: Can we replace all the optional fields with a discriminated union
  // that carries the required one ?
  accountId?: string
  sessionId?: string
  // TODO: What does it mean the comment below ?
  /** Immutable target copied into the eventual receipt; it cannot authorize any other tenant operation. */
  stepUpTarget?: {
    readonly organizationId: string
    readonly operation: StepUpOperation
    readonly resourceId: string
    readonly contextVersion: bigint
  }
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
  | "provider_not_found"
  | UnknownError
>

export interface OidcTokenResponse {
  accessToken: string
  /** OAuth 2.0 token type (typically "Bearer"), indicates how the access_token should be used */
  tokenType: string
  expiresIn?: number
  refreshToken?: string
  scope?: string
  /** OpenID Connect ID Token — a signed JWT containing user identity claims (sub, auth_time, etc.). Only returned when "openid" scope is requested. */
  idToken?: string
}

export interface OidcUserInfo {
  /** Subject identifier - REQUIRED by OpenID Connect spec */
  readonly sub: string
  /** Full name of user*/
  readonly name?: string
  /** Email address*/
  readonly email?: string
  /** Whether email has been verified*/
  readonly emailVerified?: boolean
  /** Preferred username*/
  readonly preferredUsername?: string
  /** Given name (first name)*/
  readonly givenName?: string
  /** Family name (surname)*/
  readonly familyName?: string
}

export interface OidcTokenRequest {
  grantType: "authorization_code"
  code: string
  redirectUri: string
  codeVerifier: string
  providerConnectionId: string
}

export type AgentChallengeGetError = BoundaryError | "agent_challenge_not_found" | UnknownError
export type AgentChallengeUpdateError =
  BoundaryError | "agent_challenge_update_failed" | "agent_challenge_concurrent_update" | UnknownError

export type AgentTokenError =
  | ExecutionError
  | "agent_token_generation_failed"
  | AgentGetError
  | AgentChallengeGetError
  | AgentChallengeJwtValidationError
  | AgentChallengeProcessingError
  | AgentChallengeUpdateError
  | GetChallengeByNonceError
  | UnknownError

export type AgentChallengeCreateError =
  | ExecutionError
  | BoundaryError
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
  getUserInfo(
    accessToken: string,
    expectedSubject: string,
    providerConnectionId: string
  ): TaskEither<OidcError, OidcUserInfo>
  /**
   * Generate a redirect URL to the IDP provider to obtain a token with the requested level of assurance
   */
  getAuthorizationUrl(
    pkce: PkceChallenge,
    assuranceLevel: AssuranceLevel,
    redirectUri: string,
    providerConnectionId: string
  ): Either<OidcError, string>
  /**
   * Validates the assurance level of the provided token
   */
  verifyAssuranceLevel(
    idToken: string,
    assuranceLevel: AssuranceLevel,
    providerConnectionId: string
  ): Either<OidcError, void>
}

export type GetChallengeByNonceError =
  "agent_challenge_not_found" | AgentChallengeDecoratedValidationError | UnknownError

export interface AgentChallengeRepository {
  persistChallenge(
    context: TenantContext,
    challenge: AgentChallenge
  ): TaskEither<AgentChallengeCreateError, AgentChallenge>
  getChallengeByNonce(
    context: TenantContext,
    nonce: string
  ): TaskEither<GetChallengeByNonceError, DecoratedAgentChallenge<{occ: true}>>
  updateChallenge(
    context: TenantContext,
    challenge: DecoratedAgentChallenge<{occ: true}>
  ): TaskEither<AgentChallengeUpdateError, void>
}

export type RefreshTokenCreateError = BoundaryError | RefreshTokenValidationError | UnknownError
export type RefreshTokenGetError =
  BoundaryError | "refresh_token_not_found" | RefreshTokenValidationError | UnknownError
export type RefreshTokenUpdateError =
  BoundaryError | "refresh_token_concurrent_update" | RefreshTokenValidationError | UnknownError
export type RefreshTokenRevokeError = BoundaryError | RefreshTokenValidationError | UnknownError

export type RefreshTokenRefreshError =
  | ExecutionError
  | "refresh_token_not_found"
  | "refresh_token_entity_mismatch"
  | "refresh_token_concurrent_update"
  | DpopValidationError
  | AgentTokenError
  | RefreshTokenEligibilityError
  | AuthError
  | RefreshTokenValidationError
  | UnknownError

export interface AccountRefreshTokenRepository {
  /**
   * Creates and persists a new refresh token in the repository.
   *
   * @param token - The refresh token domain object to create
   * @returns TaskEither with RefreshTokenCreateError on failure, or the created RefreshToken on success
   */
  createToken(token: AccountRefreshToken): TaskEither<RefreshTokenCreateError, AccountRefreshToken>

  /**
   * Retrieves a refresh token by its SHA-256 hash.
   *
   * @param tokenHash - The SHA-256 hash of the refresh token value
   * @returns TaskEither with RefreshTokenGetError on failure, or the decorated refresh token with OCC on success
   */
  getByTokenHash(tokenHash: string): TaskEither<RefreshTokenGetError, DecoratedAccountRefreshToken<{occ: true}>>

  /**
   * Atomically creates a new account/session refresh token and marks the old token as used.
   * Uses optimistic concurrency control to ensure the old token hasn't been modified.
   *
   * @param newTokenToPersist - The new active refresh token to create
   * @param oldTokenToUpdate - The old token to mark as used and link to the new token
   * @param occCheckOldToken - The expected OCC value of the old token for concurrency control
   * @returns TaskEither with RefreshTokenUpdateError on failure, or void on success
   */
  persistNewTokenUpdateOld(
    newTokenToPersist: DecoratedActiveAccountRefreshToken<{occ: true}>,
    oldTokenToUpdate: UsedAccountRefreshToken,
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

// TODO: What is the reason for splitting the token refresh repos in 2 distinct interfaces ?
// Why not using the same interface for both Account and Agent ? Who do they differ ?
// Is it due to the TenantContext ?
export interface AgentRefreshTokenRepository {
  createToken(context: TenantContext, token: AgentRefreshToken): TaskEither<RefreshTokenCreateError, AgentRefreshToken>
  getByTokenHash(
    context: TenantContext,
    tokenHash: string
  ): TaskEither<RefreshTokenGetError, VersionedAgentRefreshToken>
  persistNewTokenUpdateOld(
    context: TenantContext,
    newTokenToPersist: VersionedActiveAgentRefreshToken,
    oldTokenToUpdate: UsedAgentRefreshToken,
    occCheckOldToken: bigint
  ): TaskEither<RefreshTokenUpdateError, void>
  revokeFamily(context: TenantContext, familyId: string): TaskEither<RefreshTokenUpdateError, void>
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  accessTokenExpiresInSec: number
  refreshTokenExpiresInSec: number
}

export interface PrivilegedToken {
  token: string
  expiresInSec: number
}

// TODO: Why the StepUpToken repository has been removed ?

export interface PrivilegeTokenExchange {
  readonly code: string
  readonly state: string
  readonly operation: StepUpOperation
  readonly resourceId?: string
}

export interface DpopTokenRepository {
  /** Atomically marks a DPoP JTI as used and sets a TTL. Fails if JTI is already marked as used. */
  markJtiAsUsed(jti: string, ttlSeconds: number): TaskEither<UnknownError | "dpop_jti_reused", void>
}
