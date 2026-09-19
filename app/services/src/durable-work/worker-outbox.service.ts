import {Inject, Injectable} from "@nestjs/common"
import {Lease, TenantContext} from "@domain"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WORKER_TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "../transaction/interfaces"
import {WORKER_OUTBOX_REPOSITORY_TOKEN, WorkerOutboxRepository, WorkError} from "./interfaces"

/** Completes relay publication with its lease and fencing guard. */
@Injectable()
export class WorkerOutboxService {
  constructor(
    @Inject(WORKER_OUTBOX_REPOSITORY_TOKEN) private readonly outboxRepository: WorkerOutboxRepository,
    @Inject(WORKER_TRANSACTION_MANAGER_TOKEN) private readonly transactions: TenantTransactionManager
  ) {}

  /** A stale or already-released lease cannot acknowledge publication. */
  acknowledge(context: TenantContext, eventId: string, lease: Lease): TE.TaskEither<WorkError, void> {
    return this.transactions.execute(context, () =>
      pipe(
        this.outboxRepository.acknowledge(context, eventId, {
          owner: lease.owner,
          fencing: lease.fencing,
          acknowledgedAt: new Date()
        }),
        TE.chainW(updated => (updated ? TE.right(undefined) : TE.left("lease_lost" as const)))
      )
    )
  }
}
