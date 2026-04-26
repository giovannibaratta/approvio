import {ListQuotasParamsValidationError, QuotaCreate, QuotaValidationError} from "@approvio/api"
import {Quota, Versioned} from "@domain"
import {
  QuotaCreateError,
  QuotaGetError,
  QuotaListError,
  QuotaUpdateError,
  QuotaDeleteError,
  ListQuotasResult,
  CreateQuotaRequest
} from "@services"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common"
import {generateErrorPayload} from "@controllers/error"

export function mapQuotaToApi(quota: Versioned<Quota>): unknown {
  return {
    id: quota.id,
    limit: quota.limit,
    quotaType: quota.quotaType,
    scope: quota.node.type,
    targetId: quota.node.identifier,
    createdAt: quota.createdAt.toISOString(),
    updatedAt: quota.updatedAt.toISOString()
  }
}

export function mapToCreateQuotaRequest(request: QuotaCreate): CreateQuotaRequest {
  return {
    nodeType: request.scope,
    nodeIdentifier: request.targetId,
    quotaType: request.quotaType,
    limit: request.limit
  }
}

export function generateErrorResponseForGetQuota(error: QuotaGetError): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "quota_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, "Quota not found"))
    case "quota_unknown_error":
    case "quota_unsupported_node_type":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Unknown error"))
    case "quota_invalid_id":
    case "quota_malformed_quota":
    case "quota_invalid_scope":
    case "quota_invalid_quota_type":
    case "quota_invalid_limit":
    case "quota_missing_target_id":
    case "quota_invalid_target_id":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid parameters"))
  }
}

export function generateErrorResponseForCreateQuota(error: QuotaValidationError | QuotaCreateError): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "quota_unknown_error":
    case "quota_unsupported_node_type":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Unknown error"))
    case "quota_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, "Quota already exists"))
    case "quota_invalid_id":
    case "quota_malformed_quota":
    case "quota_invalid_scope":
    case "quota_invalid_quota_type":
    case "quota_invalid_limit":
    case "quota_missing_target_id":
    case "quota_invalid_target_id":
    case "malformed_object":
    case "missing_limit":
    case "invalid_limit":
    case "missing_scope":
    case "invalid_scope":
    case "missing_quotaType":
    case "invalid_quotaType":
    case "missing_targetId":
    case "invalid_targetId":
    case "invalid_scope_quotaType_combination":
    case "invalid_scope_targetId_combination":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid parameters"))
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, "Not authorized"))
  }
}

export function generateErrorResponseForUpdateQuota(error: QuotaValidationError | QuotaUpdateError): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, "Not authorized"))
    case "quota_unknown_error":
    case "quota_unsupported_node_type":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Unknown error"))
    case "quota_concurrent_modification_error":
      return new ConflictException(generateErrorPayload(errorCode, "Concurrent modification"))
    case "quota_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, "Quota not found"))
    case "quota_invalid_id":
    case "quota_malformed_quota":
    case "quota_invalid_scope":
    case "quota_invalid_quota_type":
    case "quota_invalid_limit":
    case "quota_missing_target_id":
    case "quota_invalid_target_id":
    case "malformed_object":
    case "missing_limit":
    case "invalid_limit":
    case "missing_scope":
    case "invalid_scope":
    case "missing_quotaType":
    case "invalid_quotaType":
    case "missing_targetId":
    case "invalid_targetId":
    case "invalid_scope_quotaType_combination":
    case "invalid_scope_targetId_combination":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid parameters"))
  }
}

export function generateErrorResponseForDeleteQuota(error: QuotaDeleteError): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "quota_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, "Quota not found"))
    case "quota_unknown_error":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Unknown error"))
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, "Not authorized"))
  }
}

export function generateErrorResponseForListQuotas(
  error: ListQuotasParamsValidationError | QuotaListError
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "malformed_object":
    case "invalid_page":
    case "invalid_limit":
    case "invalid_scope":
    case "invalid_targetId":
    case "invalid_quotaType":
    case "quota_invalid_limit":
    case "quota_invalid_scope":
    case "quota_invalid_id":
    case "quota_malformed_quota":
    case "quota_invalid_quota_type":
    case "quota_missing_target_id":
    case "quota_invalid_target_id":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid parameters"))
    case "quota_unknown_error":
    case "quota_unsupported_node_type":
    case "invalid_search":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Unknown error"))
  }
}

export function mapListQuotasResultToApi(result: ListQuotasResult) {
  return {
    data: result.items.map(mapQuotaToApi),
    pagination: {
      totalItems: result.total,
      totalPages: Math.ceil(result.total / result.limit) || 1,
      currentPage: result.page,
      itemsPerPage: result.limit
    }
  }
}
