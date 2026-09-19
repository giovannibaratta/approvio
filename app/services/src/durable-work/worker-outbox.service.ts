import {Inject, Injectable} from "@nestjs/common"
import {Lease, TenantContext} from "@domain"
import * as TE from "fp-ts/TaskEither"
import * as O from "fp-ts/Option"
import * as RA from "fp-ts/ReadonlyArray"
import {pipe} from "fp-ts/function"
import {WORKER_TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "../transaction/interfaces"
import {
  WORKER_OUTBOX_REPOSITORY_TOKEN,
  WorkerOutboxRepository,
  WorkError,
  OutboxClaim,
  OutboxClaimCandidate,
  OutboxClaimCriteria,
  OutboxClaimFactory
} from "./interfaces"

/** Claims relay deliveries and completes publication under their fenced leases. */
@Injectable()
export class WorkerOutboxService {
  constructor(
    @Inject(WORKER_OUTBOX_REPOSITORY_TOKEN) private readonly outboxRepository: WorkerOutboxRepository,
    @Inject(WORKER_TRANSACTION_MANAGER_TOKEN) private readonly transactions: TenantTransactionManager
  ) {}

  claim(context: TenantContext, criteria: OutboxClaimCriteria): TE.TaskEither<WorkError, ReadonlyArray<OutboxClaim>> {
    return this.transactions.execute(context, () =>
      pipe(
        this.outboxRepository.listClaimCandidates(context, criteria),
        TE.chainW(TE.traverseSeqArray(candidate => this.claimCandidate(context, criteria, candidate))),
        TE.map(RA.compact)
      )
    )
  }

  private claimCandidate(
    context: TenantContext,
    criteria: OutboxClaimCriteria,
    candidate: OutboxClaimCandidate
  ): TE.TaskEither<WorkError, O.Option<OutboxClaim>> {
    return pipe(
      OutboxClaimFactory.validate({
        event: candidate.event,
        lease: {owner: criteria.owner, fencing: candidate.fencing + 1n, expiresAt: criteria.leaseUntil}
      }),
      TE.fromEither,
      TE.chainW(claim =>
        pipe(
          this.outboxRepository.tryClaim(context, claim, candidate.occ),
          TE.map(updated => (updated ? O.some(claim) : O.none))
        )
      )
    )
  }

  /** A stale or already-released lease cannot acknowledge publication. */
  acknowledge(context: TenantContext, eventId: string, lease: Lease): TE.TaskEither<WorkError, void> {
    return this.transactions.execute(
      context,
      () =>
        pipe(
          this.outboxRepository.getAcknowledgementState(context, eventId),
          TE.chainW(state => {
            const acknowledgedAt = new Date()
            if (
              state.leaseOwner !== lease.owner ||
              state.fencing !== lease.fencing ||
              state.publishedAt !== null ||
              state.leaseUntil === null ||
              state.leaseUntil < acknowledgedAt
            )
              return TE.left("lease_lost" as const)
            return this.outboxRepository.acknowledge(context, eventId, {occ: state.occ, acknowledgedAt})
          }),
          TE.chainW(updated => (updated ? TE.right(undefined) : TE.left("lease_lost" as const)))
        ),
      // Receipt writes also bump OCC; retry the read and validation when they race acknowledgement.
      {isolationLevel: "RepeatableRead"}
    )
  }
}
