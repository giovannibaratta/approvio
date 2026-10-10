import {Injectable, Logger} from "@nestjs/common"
import {BoundaryError, TenantContext} from "@domain"
import {EventReceiptRepository} from "@services"
import * as TE from "fp-ts/TaskEither"
import {EventReceiptTenantClient} from "./tenant-database-clients"
import {isPrismaForeignKeyConstraintError} from "./errors"
import {OrganizationMismatchError} from "./database-client"

type EventConsumer = "recalculation" | "task_generation" | "task_dispatch" | "lifecycle" | "usage"

@Injectable()
export class EventReceiptDbRepository implements EventReceiptRepository {
  constructor(private readonly database: EventReceiptTenantClient) {}

  record(
    context: TenantContext,
    consumer: EventConsumer,
    eventId: string
  ): TE.TaskEither<BoundaryError | "event_mismatch" | "repository_dependency_error", "new" | "duplicate"> {
    return TE.tryCatch(
      () => this.database.transactional(context.organizationId, cx => cx.record(consumer, eventId)),
      error => {
        if (error instanceof OrganizationMismatchError) return "organization_mismatch"
        if (isPrismaForeignKeyConstraintError(error, "fk_tenant_event_receipts_outbox")) return "event_mismatch"
        Logger.error("Event receipt persistence failed", error instanceof Error ? error.name : "non_error")
        return "repository_dependency_error"
      }
    )
  }
}
