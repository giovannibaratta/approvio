import {Injectable, Logger} from "@nestjs/common"
import {PlatformSecurityEvent} from "@domain"
import {PlatformSecurityEventRepository} from "@services/platform-security"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {PlatformSecurityDatabaseClient} from "./capability-database-client"
import {mapToJsonValue} from "./shared/json-mappers"

@Injectable()
export class PlatformSecurityEventDbRepository implements PlatformSecurityEventRepository {
  constructor(private readonly security: PlatformSecurityDatabaseClient) {}

  append(event: PlatformSecurityEvent): TE.TaskEither<"unknown_error", void> {
    return pipe(
      TE.tryCatch(
        () =>
          this.security.transactional(cx =>
            cx.platformSecurityEvent.createMany({
              data: [
                {
                  id: event.id,
                  eventType: event.type,
                  actorType: event.actor.type,
                  actorId: event.actor.id,
                  reason: event.type === "organization.bootstrapped" ? null : event.reason,
                  metadata: mapToJsonValue(mapEventMetadata(event)),
                  occurredAt: event.occurredAt
                }
              ]
            })
          ),
        error => {
          Logger.error("Platform security event append failed", error instanceof Error ? error.name : "non_error")
          return "unknown_error" as const
        }
      ),
      TE.map(() => undefined)
    )
  }
}

function mapEventMetadata(event: PlatformSecurityEvent): Record<string, unknown> {
  switch (event.type) {
    case "organization.bootstrapped":
    case "organization.owner_restored":
      return {organizationId: event.organizationId, accountId: event.accountId}
    case "organization.suspended":
    case "organization.resumed":
      return {organizationId: event.organizationId}
    case "organization.grace_period_changed":
      return {organizationId: event.organizationId, ...(event.dueAt ? {dueAt: event.dueAt.toISOString()} : {})}
  }
}
