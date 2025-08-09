import {OidcUserInfo} from "@services/auth"
import * as E from "fp-ts/Either"

/**
 * Type-safe OIDC server metadata with guaranteed required endpoints.
 * This interface ensures that all OIDC spec required endpoints are non-optional.
 */
export interface OidcServerMetadata {
  /** The issuer identifier URL */
  readonly issuer: string
  /** OAuth 2.0 authorization endpoint URL */
  readonly authorization_endpoint: string
  /** OAuth 2.0 token endpoint URL */
  readonly token_endpoint: string
  /** OpenID Connect UserInfo endpoint URL */
  readonly userinfo_endpoint: string
}

/**
 * Raw UserInfo response from the OIDC provider before validation.
 * This represents the untrusted JSON structure that needs validation.
 */
export interface RawUserInfoResponse {
  [key: string]: unknown
}

/**
 * UserInfo validation error types according to OpenID Connect specification.
 */
export type UserInfoValidationError =
  | "invalid_json_structure"
  | "missing_required_sub_claim"
  | "invalid_sub_claim_type"
  | "invalid_claim_type"

/**
 * Validates UserInfo response according to OpenID Connect specification.
 * According to RFC: https://openid.net/specs/openid-connect-core-1_0.html#UserInfo
 *
 * Requirements:
 * - Must contain 'sub' claim (subject identifier)
 * - 'sub' must be a string
 * - Optional claims (name, email, etc.) must be proper types if present
 */
export function validateUserInfoResponse(
  rawResponse: RawUserInfoResponse
): E.Either<UserInfoValidationError, OidcUserInfo> {
  if (!rawResponse || typeof rawResponse !== "object" || Array.isArray(rawResponse))
    return E.left("invalid_json_structure")
  if (!("sub" in rawResponse) || rawResponse.sub === undefined || rawResponse.sub === null)
    return E.left("missing_required_sub_claim")
  if (typeof rawResponse.sub !== "string" || rawResponse.sub.trim() === "") return E.left("invalid_sub_claim_type")

  // Validate optional claims types if present
  const optionalClaims = ["name", "email", "preferred_username", "given_name", "family_name"]
  for (const claim of optionalClaims) {
    if (claim in rawResponse && rawResponse[claim] !== undefined && rawResponse[claim] !== null)
      if (typeof rawResponse[claim] !== "string") return E.left("invalid_claim_type")
  }

  // Validate email_verified if present (must be boolean)
  if (
    "email_verified" in rawResponse &&
    rawResponse.email_verified !== undefined &&
    rawResponse.email_verified !== null
  )
    if (typeof rawResponse.email_verified !== "boolean") return E.left("invalid_claim_type")

  // All validations passed - construct validated response
  const validatedUserInfo: OidcUserInfo = {
    sub: rawResponse.sub
  }

  // Add optional claims if present and valid - using object construction
  const result: OidcUserInfo = {
    ...validatedUserInfo,
    ...(rawResponse.name && typeof rawResponse.name === "string" ? {name: rawResponse.name} : {}),
    ...(rawResponse.email && typeof rawResponse.email === "string" ? {email: rawResponse.email} : {}),
    ...(typeof rawResponse.email_verified === "boolean" ? {email_verified: rawResponse.email_verified} : {}),
    ...(rawResponse.preferred_username && typeof rawResponse.preferred_username === "string"
      ? {preferred_username: rawResponse.preferred_username}
      : {}),
    ...(rawResponse.given_name && typeof rawResponse.given_name === "string"
      ? {given_name: rawResponse.given_name}
      : {}),
    ...(rawResponse.family_name && typeof rawResponse.family_name === "string"
      ? {family_name: rawResponse.family_name}
      : {})
  }

  return E.right(result)
}
