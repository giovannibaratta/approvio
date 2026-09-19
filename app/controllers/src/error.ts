import {HttpException, HttpStatus, Logger} from "@nestjs/common"

export interface ErrorPayload {
  message: string
  code: string
}

export function generateErrorPayload(code: string, message: string): ErrorPayload {
  if (code.trim().length < 0) throw Error("Code can not be an empty string")

  return {
    message,
    code
  }
}

export type MappedAuthorityError =
  | "organization_context_changed"
  | "organization_suspended"
  | "organization_deleting"
  | "organization_not_found"
  | "resource_not_found"
  | "invalid_credential"
  | "account_not_found"
  | "permission_denied"
  | "organization_mismatch"
  | "repository_dependency_error"
  | "storage_unavailable"
  | "commit_outcome_unknown"
  | "retry_exhausted"

export function isAuthorityError(error: string): error is MappedAuthorityError {
  switch (error) {
    case "organization_context_changed":
    case "organization_suspended":
    case "organization_deleting":
    case "organization_not_found":
    case "resource_not_found":
    case "invalid_credential":
    case "account_not_found":
    case "permission_denied":
    case "organization_mismatch":
    case "repository_dependency_error":
    case "storage_unavailable":
    case "commit_outcome_unknown":
    case "retry_exhausted":
      return true
  }
  return false
}

/** Maps expected current-authority failures at the HTTP boundary; unrelated errors remain caller-owned. */
export function mapAuthorityError(error: MappedAuthorityError): HttpException {
  switch (error) {
    case "organization_context_changed":
      return new HttpException(
        generateErrorPayload("ORGANIZATION_CONTEXT_CHANGED", "Organization context changed"),
        HttpStatus.CONFLICT
      )
    case "organization_suspended":
      return new HttpException(
        generateErrorPayload("ORGANIZATION_SUSPENDED", "Organization is suspended"),
        HttpStatus.LOCKED
      )
    case "organization_deleting":
    case "organization_not_found":
    case "resource_not_found":
      return new HttpException(generateErrorPayload("RESOURCE_NOT_FOUND", "Resource not found"), HttpStatus.NOT_FOUND)
    case "invalid_credential":
    case "account_not_found":
      return new HttpException(
        generateErrorPayload("INVALID_CREDENTIAL", "Credential is no longer active"),
        HttpStatus.UNAUTHORIZED
      )
    case "permission_denied":
    case "organization_mismatch":
      return new HttpException(generateErrorPayload("PERMISSION_DENIED", "Permission denied"), HttpStatus.FORBIDDEN)
    case "repository_dependency_error":
    case "storage_unavailable":
    case "commit_outcome_unknown":
    case "retry_exhausted":
      Logger.error(`Authority evaluation failed: ${error}`, "ErrorMapper")
      return new HttpException(
        generateErrorPayload("UNKNOWN_ERROR", "Internal server error"),
        HttpStatus.INTERNAL_SERVER_ERROR
      )
  }
}
