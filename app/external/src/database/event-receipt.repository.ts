import {recordTenantEventReceipt} from "./event-receipt-operation"
import {fromPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {BoundaryError, TenantContext} from "@domain"
import {EventReceiptRepository, EventReceiptConsumer} from "@services"
import * as TE from "fp-ts/TaskEither"
import {EventReceiptTenantClient} from "./tenant-database-clients"
import {isPrismaForeignKeyConstraintError} from "./errors"
import {OrganizationMismatchError} from "./database-client"

@Injectable()
export class EventReceiptDbRepository implements EventReceiptRepository {
  constructor(private readonly database: EventReceiptTenantClient) {}

  record(
    context: TenantContext,
    consumer: EventReceiptConsumer,
    eventId: string
  ): TE.TaskEither<BoundaryError | "event_not_found" | "repository_dependency_error", "new" | "duplicate"> {
    return fromPromise(
      () =>
        this.database.transactional(context.organizationId, cx =>
          recordTenantEventReceipt(cx, context.organizationId, consumer, eventId)
        ),
      error => {
        if (error instanceof OrganizationMismatchError) return "organization_mismatch"
        if (isPrismaForeignKeyConstraintError(error, "fk_tenant_event_receipts_outbox")) return "event_not_found"
        Logger.error("Event receipt persistence failed", error)
        return "repository_dependency_error"
      }
    )
  }
}
