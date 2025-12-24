import {Either, isLeft, left, right} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as jose from "jose"
import {PrefixUnion} from "./types"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {webcrypto} from "node:crypto"

/**
 * DPoP validation error types
 */
export type DpopValidationError = PrefixUnion<
  "dpop",
  | "expected_url_parsing_failed"
  | "htu_url_parsing_failed"
  | "import_key_failed"
  | "invalid_htm_claim"
  | "invalid_htu_claim"
  | "invalid_signature"
  | "jwt_expired"
  | "jwt_invalid"
  | "jwt_verify_failed"
  | "missing_htm_claim"
  | "missing_htu_claim"
  | "missing_iat_claim"
  | "missing_jti_claim"
>

/**
 * Maximum age for DPoP proof in seconds (5 minutes)
 */
export const DPOP_MAX_AGE_SECONDS = 5 * 60

/**
 * Clock skew tolerance in seconds
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 30

/**
 * Normalizes URL for DPoP validation according to RFC 9449 Section 4.3, Point 9
 *
 * This function is essential for security and RFC compliance. It strips query parameters
 * and URL fragments to ensure proper comparison of HTTP URIs in DPoP validation.
 *
 * RFC 9449 requires that when validating the `htu` (HTTP URI) claim:
 * "The htu claim matches the HTTP URI value for the HTTP request in which the JWT was received,
 * ignoring any query and fragment parts."
 *
 * Security Considerations:
 * - Prevents attackers from bypassing validation by adding query parameters
 * - Ensures consistent comparison by removing URL fragments
 * - Maintains security boundaries by comparing only protocol, host, and pathname
 *
 * Example:
 * - Input: "https://server.example.com/token?malicious=param#section"
 * - Output: "https://server.example.com/token"
 *
 * @param url - The URL to normalize (can be expected URL or DPoP htu claim)
 * @returns Normalized URL containing only protocol, host, and pathname
 */
function normalizeUrl<E>(url: string, error: E): Either<E, string> {
  try {
    const parsed = new URL(url)
    return right(`${parsed.protocol}//${parsed.host}${parsed.pathname}`)
  } catch {
    return left(error)
  }
}

/**
 * Validates DPoP JWT signature and structure for service layer use
 *
 * This function performs signature validation and basic structure checks
 * without validating HTTP-specific claims. It's designed for the service layer
 * where the controller has already validated the HTTP-specific aspects.
 *
 * @param dpopJwt - The DPoP JWT to validate
 * @param agentPublicKeyPem - Agent's public key in PEM format for signature verification
 * @returns TaskEither with validation error or the decoded DPoP payload
 */
export function validateDpopJwt(
  dpopJwt: string,
  agentPublicKeyPem: string,
  validations: {expectedMethod: string; expectedUrl: string}
): TaskEither<DpopValidationError, true> {
  return pipe(
    TE.Do,
    TE.bindW("importedPublicKey", () => importSPKITask(agentPublicKeyPem)),
    TE.bindW("verifiedJwt", ({importedPublicKey}) => jwtVerifyTask(dpopJwt, importedPublicKey)),
    TE.chainW(({verifiedJwt}) => {
      const {jti, htm, htu, iat} = verifiedJwt.payload

      if (!jti) return TE.left("dpop_missing_jti_claim" as const)
      if (!htm) return TE.left("dpop_missing_htm_claim" as const)
      if (!htu) return TE.left("dpop_missing_htu_claim" as const)
      if (!iat) return TE.left("dpop_missing_iat_claim" as const)

      if (typeof htm !== "string") return TE.left("dpop_invalid_htm_claim" as const)
      if (typeof htu !== "string") return TE.left("dpop_invalid_htu_claim" as const)

      if (htm !== validations.expectedMethod) return TE.left("dpop_invalid_htm_claim" as const)

      // Validate HTTP URI (normalize and compare without query/fragment)
      // RFC 9449 Section 4.3, Point 9: "The htu claim matches the HTTP URI value for the HTTP request
      // in which the JWT was received, ignoring any query and fragment parts."
      const eitherNormalizedExpectedUrl = normalizeUrl(
        validations.expectedUrl,
        "dpop_expected_url_parsing_failed" as const
      )
      const eitherNormalizedHtu = normalizeUrl(htu, "dpop_htu_url_parsing_failed" as const)

      if (isLeft(eitherNormalizedExpectedUrl)) return TE.fromEither(eitherNormalizedExpectedUrl)
      if (isLeft(eitherNormalizedHtu)) return TE.fromEither(eitherNormalizedHtu)
      if (eitherNormalizedExpectedUrl.right !== eitherNormalizedHtu.right)
        return TE.left("dpop_invalid_htu_claim" as const)

      return TE.right(true)
    })
  )
}

function importSPKITask(agentPublicKeyPem: string): TaskEither<"dpop_import_key_failed", webcrypto.CryptoKey> {
  return TE.tryCatch(
    async () => {
      return await jose.importSPKI(agentPublicKeyPem, "RS256")
    },
    () => {
      return "dpop_import_key_failed" as const
    }
  )
}

function jwtVerifyTask(
  dpopJwt: string,
  agentPublicKey: webcrypto.CryptoKey
): TaskEither<
  | "dpop_jwt_verify_failed"
  | "dpop_missing_iat_claim"
  | "dpop_missing_htm_claim"
  | "dpop_missing_htu_claim"
  | "dpop_missing_jti_claim"
  | "dpop_jwt_expired"
  | "dpop_jwt_invalid"
  | "dpop_invalid_signature",
  jose.JWTVerifyResult<jose.JWTPayload>
> {
  return TE.tryCatch(
    async () => {
      return await jose.jwtVerify(dpopJwt, agentPublicKey, {
        algorithms: ["RS256"], // Agent keys are RSA 4096-bit
        requiredClaims: ["jti", "htm", "htu", "iat"],
        issuer: undefined, // No issuer validation for DPoP
        audience: undefined, // No audience validation for DPoP,
        typ: "dpop+jwt",
        clockTolerance: CLOCK_SKEW_TOLERANCE_SECONDS,
        maxTokenAge: DPOP_MAX_AGE_SECONDS
      })
    },
    error => {
      if (error instanceof jose.errors.JWTClaimValidationFailed) {
        if (error.reason === "missing" && error.claim === "iat") return "dpop_missing_iat_claim" as const
        if (error.reason === "missing" && error.claim === "htm") return "dpop_missing_htm_claim" as const
        if (error.reason === "missing" && error.claim === "htu") return "dpop_missing_htu_claim" as const
        if (error.reason === "missing" && error.claim === "jti") return "dpop_missing_jti_claim" as const
      }
      if (error instanceof jose.errors.JWTExpired) return "dpop_jwt_expired" as const
      // Overall structure of JWT is not valid
      if (error instanceof jose.errors.JWTInvalid) return "dpop_jwt_invalid" as const
      if (error instanceof jose.errors.JWSInvalid) return "dpop_jwt_invalid" as const
      if (error instanceof jose.errors.JWSSignatureVerificationFailed) return "dpop_invalid_signature" as const
      return "dpop_jwt_verify_failed" as const
    }
  )
}
