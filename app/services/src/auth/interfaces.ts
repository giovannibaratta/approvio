import {PrefixUnion} from "@utils/types"
import {TaskEither} from "fp-ts/lib/TaskEither"

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
  codeVerifier: string
  codeChallenge: string
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

export const PKCE_SESSION_REPOSITORY_TOKEN = "PKCE_SESSION_REPOSITORY_TOKEN"

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
>

export interface OidcTokenResponse {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
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

export const OIDC_PROVIDER_TOKEN = "OIDC_PROVIDER_TOKEN"

export interface OidcProvider {
  getAuthorizationEndpoint(): TaskEither<OidcError, string>
  exchangeCodeForTokens(request: OidcTokenRequest): TaskEither<OidcError, OidcTokenResponse>
  getUserInfo(accessToken: string): TaskEither<OidcError, OidcUserInfo>
}
