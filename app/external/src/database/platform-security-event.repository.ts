import {fromPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {PlatformSecurityEvent, PlatformSecurityEventFactory} from "@domain"
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
      fromPromise(
        () =>
          this.security.transactional(cx =>
            // This capability has INSERT only; createMany avoids Prisma create's RETURNING/SELECT requirement.
            cx.platformSecurityEvent.createMany({
              data: [
                {
                  id: event.id,
                  eventType: event.type,
                  actorType: event.actor.type,
                  actorId: event.actor.id,
                  reason: event.type === "organization.bootstrapped" ? null : event.reason,
                  metadata: mapToJsonValue(PlatformSecurityEventFactory.toMetadata(event)),
                  occurredAt: event.occurredAt
                }
              ]
            })
          ),
        error => {
          Logger.error("Platform security event append failed", error)
          return "unknown_error" as const
        }
      ),
      TE.map(() => undefined)
    )
  }
}
