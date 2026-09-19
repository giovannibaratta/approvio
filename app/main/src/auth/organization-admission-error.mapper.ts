import {HttpException, HttpStatus, Logger} from "@nestjs/common"
import type {OrganizationAdmissionError} from "@services/tenancy/organization-admission.service"
import {generateErrorPayload} from "@controllers/error"

export function mapOrganizationAdmissionError(error: OrganizationAdmissionError): HttpException {
  switch (error) {
    case "organization_suspended":
      return new HttpException(
        generateErrorPayload("ORGANIZATION_SUSPENDED", "Organization is suspended"),
        HttpStatus.LOCKED
      )
    case "organization_deleting":
    case "organization_not_found":
      return new HttpException(generateErrorPayload("RESOURCE_NOT_FOUND", "Resource not found"), HttpStatus.NOT_FOUND)
    case "permission_denied":
    case "organization_mismatch":
      return new HttpException(generateErrorPayload("PERMISSION_DENIED", "Permission denied"), HttpStatus.FORBIDDEN)
    case "invalid_organization_id":
      return new HttpException(
        generateErrorPayload("INVALID_ORGANIZATION", "Invalid organization"),
        HttpStatus.BAD_REQUEST
      )
    case "tenant_context_required":
      Logger.error("Tenant context is missing during organization admission")
      return new HttpException(
        generateErrorPayload("UNKNOWN_ERROR", "Organization admission failed"),
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    case "repository_dependency_error":
    case "conflicting_isolation_level":
    case "storage_unavailable":
    case "commit_outcome_unknown":
    case "retry_exhausted":
    case "concurrency_error":
      Logger.error(`Organization admission failed: ${error}`)
      return new HttpException(
        generateErrorPayload("UNKOWN_ERROR", "Tenant admission is unavailable"),
        HttpStatus.SERVICE_UNAVAILABLE
      )
  }
}
