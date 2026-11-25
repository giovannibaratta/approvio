import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "../transaction/interfaces"
import {isDeepStrictEqual} from "node:util"
import {BoundaryError, TenantContext, TenantEvent, TenantEventValidationError} from "@domain"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {TENANT_OUTBOX_REPOSITORY_TOKEN, OutboxAppendFactory, TenantOutboxRepository, WorkError} from "./interfaces"
import {Inject, Injectable} from "@nestjs/common"

@Injectable()
export class TenantOutboxService {
  constructor(
    @Inject(TENANT_OUTBOX_REPOSITORY_TOKEN) private readonly outboxRepository: TenantOutboxRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly transactions: TenantTransactionManager
  ) {}

  markPublished(context: TenantContext, eventId: string): TE.TaskEither<WorkError, void> {
    const getPublicationState = () =>
      pipe(
        this.outboxRepository.getPublicationState(context, eventId),
        TE.chainW(TE.fromOption(() => "event_not_found" as const))
      )

    return this.transactions.execute(context, () =>
      pipe(
        getPublicationState(),
        TE.chainW(state => {
          if (state.state !== "pending") return TE.right(undefined)
          return pipe(
            this.outboxRepository.tryMarkPublished(context, eventId, new Date()),
            TE.chainW(updated =>
              updated
                ? TE.right(undefined)
                : pipe(
                    // A competing publisher or relay may have taken responsibility for this event.
                    getPublicationState(),
                    TE.chainW(current =>
                      current.state === "pending" ? TE.left("concurrency_error" as const) : TE.right(undefined)
                    )
                  )
            )
          )
        })
      )
    )
  }

  /** Appends or verifies an identical replay inside the caller's transaction. */
  append(
    context: TenantContext,
    event: TenantEvent,
    availableAt?: Date
  ): TE.TaskEither<
    BoundaryError | TenantEventValidationError | "event_not_found" | "event_mismatch" | "repository_dependency_error",
    void
  > {
    if (event.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    return pipe(
      this.outboxRepository.append(context, OutboxAppendFactory.create(event, availableAt)),
      TE.chainW(inserted => {
        if (inserted) return TE.right(undefined)
        // Replayed event IDs must retain their original payload; conflicting reuse is rejected.
        return pipe(
          this.outboxRepository.getEvent(context, event.eventId),
          TE.chainW(existing =>
            isDeepStrictEqual(existing, event) ? TE.right(undefined) : TE.left("event_mismatch" as const)
          )
        )
      })
    )
  }
}
