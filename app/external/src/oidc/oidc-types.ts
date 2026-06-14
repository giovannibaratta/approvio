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

  const validatedOptionalClaims = validateOptionalClaims(rawResponse)
  if (E.isLeft(validatedOptionalClaims)) return validatedOptionalClaims

  const validatedEmailVerified = validateEmailVerified(rawResponse)
  if (E.isLeft(validatedEmailVerified)) return validatedEmailVerified

  const result: OidcUserInfo = {
    sub: rawResponse.sub,
    ...validatedOptionalClaims.right,
    ...(validatedEmailVerified.right !== undefined ? {emailVerified: validatedEmailVerified.right} : {})
  }

  return E.right(result)
}

function validateOptionalClaims(
  rawResponse: RawUserInfoResponse
): E.Either<UserInfoValidationError, Partial<OidcUserInfo>> {
  const result: Record<string, string> = {}

  const validateStringClaim = (key: string): E.Either<UserInfoValidationError, string | undefined> => {
    const value = rawResponse[key]
    if (value === undefined || value === null) return E.right(undefined)
    if (typeof value !== "string") return E.left("invalid_claim_type")
    return E.right(value)
  }

  const name = validateStringClaim("name")
  if (E.isLeft(name)) return name
  if (name.right) result.name = name.right

  const email = validateStringClaim("email")
  if (E.isLeft(email)) return email
  if (email.right) result.email = email.right

  const preferredUsername = validateStringClaim("preferred_username")
  if (E.isLeft(preferredUsername)) return preferredUsername
  if (preferredUsername.right) result.preferredUsername = preferredUsername.right

  const givenName = validateStringClaim("given_name")
  if (E.isLeft(givenName)) return givenName
  if (givenName.right) result.givenName = givenName.right

  const familyName = validateStringClaim("family_name")
  if (E.isLeft(familyName)) return familyName
  if (familyName.right) result.familyName = familyName.right

  return E.right(result as Partial<OidcUserInfo>)
}

function validateEmailVerified(
  rawResponse: RawUserInfoResponse
): E.Either<UserInfoValidationError, boolean | undefined> {
  const value = rawResponse.email_verified
  if (value === undefined || value === null) return E.right(undefined)

  if (typeof value === "boolean") return E.right(value)

  if (typeof value === "string") {
    const lowerVal = value.toLowerCase()
    if (lowerVal === "true") return E.right(true)
    if (lowerVal === "false") return E.right(false)
  }

  return E.left("invalid_claim_type")
}
