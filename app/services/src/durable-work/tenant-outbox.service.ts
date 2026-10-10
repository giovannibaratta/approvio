import {WORKER_TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "../transaction/interfaces"
import {isDeepStrictEqual} from "node:util"
import {BoundaryError, Lease, TenantContext, TenantEventFactory, TenantEventValidationError} from "@domain"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {OUTBOX_REPOSITORY_TOKEN, OutboxAppendFactory, OutboxRepository, WorkError} from "./interfaces"
import {Inject, Injectable} from "@nestjs/common"

@Injectable()
export class TenantOutboxService {
  constructor(
    @Inject(OUTBOX_REPOSITORY_TOKEN) private readonly outbox: OutboxRepository,
    @Inject(WORKER_TRANSACTION_MANAGER_TOKEN) private readonly transactions: TenantTransactionManager
  ) {}

  /** An owned lease, including an expired one, is completed or reclaimed by the relay. */
  markPublished(
    context: TenantContext,
    eventId: string,
    publishedAt: Date = new Date()
  ): TE.TaskEither<WorkError, void> {
    const mark = (canWrite: boolean): TE.TaskEither<WorkError, void> =>
      pipe(
        this.outbox.getPublicationState(context, eventId),
        TE.chainW(TE.fromOption(() => "event_mismatch" as const)),
        TE.chainW(state => {
          if (state.state !== "pending") return TE.right(undefined)
          if (!canWrite) return TE.left("concurrency_error" as const)
          return pipe(
            this.outbox.tryMarkPublished(context, eventId, publishedAt),
            TE.chainW(updated => (updated ? TE.right(undefined) : mark(false)))
          )
        })
      )
    return this.transactions.execute(context, () => mark(true))
  }

  /** Appends or verifies an identical replay inside the caller's transaction. */
  append(
    context: TenantContext,
    event: unknown,
    availableAt?: Date
  ): TE.TaskEither<
    BoundaryError | TenantEventValidationError | "event_not_found" | "event_mismatch" | "repository_dependency_error",
    void
  > {
    return pipe(
      TE.fromEither(TenantEventFactory.validate(event)),
      TE.chainW(validated => {
        if (validated.organizationId !== context.organizationId) return TE.left("organization_mismatch" as const)
        return pipe(
          this.outbox.append(context, OutboxAppendFactory.create(validated, availableAt)),
          TE.chainW(inserted =>
            inserted
              ? TE.right(undefined)
              : pipe(
                  this.outbox.getEvent(context, validated.eventId),
                  TE.chainW(existing =>
                    isDeepStrictEqual(existing, validated) ? TE.right(undefined) : TE.left("event_mismatch" as const)
                  )
                )
          )
        )
      })
    )
  }

  /** A stale or already-released lease cannot acknowledge publication. */
  acknowledge(
    context: TenantContext,
    eventId: string,
    lease: Lease,
    acknowledgedAt: Date = new Date()
  ): TE.TaskEither<WorkError, void> {
    // Outbox attempts are stored as a PostgreSQL signed 32-bit integer.
    if (lease.fencing < 1n || lease.fencing > 2_147_483_647n) return TE.left("lease_invalid_fencing")
    const fencing = Number(lease.fencing)
    return this.transactions.execute(context, () =>
      pipe(
        this.outbox.acknowledge(context, eventId, {owner: lease.owner, fencing, acknowledgedAt}),
        TE.chainW(updated => (updated ? TE.right(undefined) : TE.left("lease_lost" as const)))
      )
    )
  }
}
