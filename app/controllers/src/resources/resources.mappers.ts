import {ResourceResolveResponse, ResourcesService} from "@services"
import {HttpException, BadRequestException, ForbiddenException, InternalServerErrorException} from "@nestjs/common"
import {generateErrorPayload} from "@controllers/error"
import {ResourceResolveResponse as ApiResourceResolveResponse, validateResourceResolveRequest} from "@approvio/api"
import {ExtractLeftFromFn, ExtractLeftFromMethod} from "@utils"

export function mapToResourceResolveResponse(serviceResponse: ResourceResolveResponse): ApiResourceResolveResponse {
  return {
    resolved: serviceResponse.resolved.map(r => ({
      type: r.type,
      id: r.id,
      name: r.name
    })),
    denied: serviceResponse.denied.map(d => ({
      type: d.type,
      id: d.id,
      reason: d.reason
    }))
  }
}

type ResolveErorr =
  | ExtractLeftFromMethod<typeof ResourcesService, "resolveResources">
  | "too_many_resources"
  | ExtractLeftFromFn<typeof validateResourceResolveRequest>

export function generateErrorResponseForResolveResources(error: ResolveErorr, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_mismatch":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "commit_outcome_unknown":
    case "storage_unavailable":
    case "concurrency_error":
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unknown error`))
    case "too_many_resources":
    case "malformed_object":
    case "missing_resources":
    case "invalid_resources_type":
    case "empty_resources":
    case "invalid_resource_item":
    case "missing_resource_type":
    case "invalid_resource_type_value":
    case "missing_resource_id":
    case "invalid_resource_id_format":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid request: ${error}`))
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: not authorized`))
  }
}
