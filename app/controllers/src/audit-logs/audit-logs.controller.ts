import {Controller, Get, Query, HttpCode, HttpStatus} from "@nestjs/common"
import {validateListAuditLogsParams, validateListMyAuditLogsParams} from "@approvio/api"
import {GetAuthenticatedEntity} from "@app/auth"
import {AuthenticatedEntity} from "@domain"
import {AuditLogService} from "@services"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {isLeft} from "fp-ts/Either"
import {logSuccess} from "@utils"

import {
  mapToServiceListRequest,
  mapToServiceListMyRequest,
  mapListAuditLogsResultToApi,
  generateErrorResponseForListAuditLogs
} from "./audit-logs.mappers"

export const AUDIT_LOGS_ENDPOINT_ROOT = "audit-logs"

/**
 * Coerces single query parameter values into single-item arrays for specified keys.
 *
 * **Why this is needed:**
 * Express and NestJS query parsers parse query parameters specified only once (e.g. `?actors=user:id`)
 * as a single string, but parse query parameters specified multiple times (e.g. `?actors=user:A&actors=user:B`)
 * as an array of strings. Since our validator schemas (e.g. `validateListAuditLogsParams`) strictly require
 * these filter parameters to be arrays, this helper coerces single values into arrays so that the API handles
 * both single-item and multi-item query filters gracefully without validation failures.
 *
 * @param query The raw query record from the request
 * @param keys The query keys to check and coerce into arrays if they exist
 * @returns A shallow copy of the query object with the specified parameters normalized to arrays
 */
function coerceQueryArray(query: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result = {...query}
  for (const key of keys) {
    if (result[key] !== undefined && !Array.isArray(result[key])) {
      result[key] = [result[key]]
    }
  }
  return result
}

@Controller(AUDIT_LOGS_ENDPOINT_ROOT)
export class AuditLogsController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async listAuditLogs(
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Query() query: Record<string, unknown>
  ) {
    const eitherResult = await pipe(
      coerceQueryArray(query, ["actors", "targets", "auditTypes"]),
      validateListAuditLogsParams,
      E.chainW(mapToServiceListRequest),
      TE.fromEither,
      TE.chainW(validatedRequest => this.auditLogService.listAuditLogs(requestor, validatedRequest)),
      TE.map(result => mapListAuditLogsResultToApi(result)),
      logSuccess("Audit logs listed", "AuditLogsController")
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForListAuditLogs(eitherResult.left)

    return eitherResult.right
  }

  @Get("me")
  @HttpCode(HttpStatus.OK)
  async listMyAuditLogs(
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Query() query: Record<string, unknown>
  ) {
    const eitherResult = await pipe(
      coerceQueryArray(query, ["targets", "auditTypes"]),
      validateListMyAuditLogsParams,
      E.chainW(mapToServiceListMyRequest),
      TE.fromEither,
      TE.chainW(validatedRequest => this.auditLogService.listMyAuditLogs(requestor, validatedRequest)),
      TE.map(result => mapListAuditLogsResultToApi(result)),
      logSuccess("My audit logs listed", "AuditLogsController")
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForListAuditLogs(eitherResult.left)

    return eitherResult.right
  }
}
