import {
  ListAuditLogsParamsValidationError,
  ListMyAuditLogsParamsValidationError,
  ListAuditLogsParams,
  ListMyAuditLogsParams
} from "@approvio/api"
import {AuditLogService, ListAuditLogResponse, ListAuditLogsRequest, ListMyAuditLogsRequest} from "@services"
import {BadRequestException, ForbiddenException, HttpException, InternalServerErrorException} from "@nestjs/common"
import {generateErrorPayload} from "@controllers/error"
import {Either} from "fp-ts/Either"
import * as E from "fp-ts/Either"
import * as A from "fp-ts/Array"
import {ExtractLeftFromMethod} from "@utils"
import {pipe} from "fp-ts/function"

const DEFAULT_LIMIT = 20

function parseFormattedStrings(
  items: string[] | undefined
): Either<"invalid_targets", Array<{entityType: string; entityId: string}> | undefined> {
  if (!items) return E.right(undefined)

  return pipe(
    items,
    A.traverse(E.Applicative)(item => {
      const [entityType, entityId] = item.split(":")

      if (!entityType || !entityId) return E.left("invalid_targets" as const)

      return E.right({entityType, entityId})
    })
  )
}

function parseActors(
  items: string[] | undefined
): Either<"invalid_actors", Array<{actorType: string; actorId: string}> | undefined> {
  if (!items) return E.right(undefined)

  return pipe(
    items,
    A.traverse(E.Applicative)(item => {
      const [actorType, actorId] = item.split(":")

      if (!actorType || !actorId) return E.left("invalid_actors" as const)

      return E.right({actorType, actorId})
    })
  )
}

export function mapToServiceListRequest(
  request: ListAuditLogsParams
): Either<ListAuditLogsParamsValidationError, ListAuditLogsRequest> {
  return pipe(
    E.Do,
    E.bindW("targets", () => parseFormattedStrings(request.targets)),
    E.bindW("actors", () => parseActors(request.actors)),
    E.map(({targets, actors}) => ({
      cursor: request.cursor,
      limit: request.limit ?? DEFAULT_LIMIT,
      targets: targets ? targets : undefined,
      actors: actors ? actors : undefined,
      auditTypes: request.auditTypes
    }))
  )
}

export function mapToServiceListMyRequest(
  request: ListMyAuditLogsParams
): Either<ListMyAuditLogsParamsValidationError, ListMyAuditLogsRequest> {
  return pipe(
    parseFormattedStrings(request.targets),
    E.map(targets => ({
      cursor: request.cursor,
      limit: request.limit ?? DEFAULT_LIMIT,
      targets: targets ? targets : undefined,
      auditTypes: request.auditTypes
    }))
  )
}

type ListAuditLogsError = ExtractLeftFromMethod<typeof AuditLogService, "listAuditLogs">

export function generateErrorResponseForListAuditLogs(
  error: ListAuditLogsParamsValidationError | ListAuditLogsError
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "malformed_object":
    case "invalid_limit":
    case "invalid_cursor":
    case "invalid_targets":
    case "invalid_actors":
    case "invalid_audit_types":
    case "invalid_page":
    case "invalid_search":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid parameters"))
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, "Not authorized to list audit logs"))
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Unknown error"))
  }
}

export function mapListAuditLogsResultToApi(result: ListAuditLogResponse) {
  return {
    auditLogs: result.items.map(log => ({
      id: log.id,
      auditType: log.auditType,
      target: {
        type: log.entityType,
        id: log.entityId
      },
      actor: log.actor,
      createdAt: log.createdAt.toISOString(),
      payload: log.payload
    })),
    pagination: result.hasMore
      ? {
          hasMore: true as const,
          nextCursor: result.nextCursor
        }
      : {
          hasMore: false as const
        }
  }
}
