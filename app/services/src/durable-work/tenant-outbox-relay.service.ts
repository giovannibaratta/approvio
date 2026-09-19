import {Inject, Injectable, Logger} from "@nestjs/common"
import {OrganizationSummaryValidationError, OrganizationSummary, TenantContext} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {OrganizationDirectoryRepository, ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN} from "../tenancy/interfaces"
import {OutboxClaim, WorkError} from "./interfaces"
import {WorkerOutboxService} from "./worker-outbox.service"
import {outboxRecoveryCriteria} from "./tenant-outbox.utils"
import {QueueService} from "../queue/queue.service"
import {EnqueueTenantEventError} from "../queue/interface"
import {RepositoryDependencyError} from "../error"

const ORGANIZATIONS_PER_PAGE = 50
const EVENTS_PER_ORGANIZATION = 10

@Injectable()
export class TenantOutboxRelayService {
  constructor(
    private readonly workerOutbox: WorkerOutboxService,
    @Inject(ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN)
    private readonly organizationsRepo: OrganizationDirectoryRepository,
    private readonly queue: QueueService
  ) {}

  /**
   * Recovers old unpublished events and published deliveries missing their consumer receipt.
   * Owner is the worker-instance ID persisted in each fenced, one-minute outbox lease.
   * Scans active organizations, claiming at most batchSize events per organization in a DB
   * transaction, then enqueues and acknowledges each event sequentially outside that transaction.
   * Claim failures skip the organization; publish/acknowledgement failures stop its batch.
   * Unacknowledged claims remain eligible for recovery after lease expiry. Right means the
   * scan completed, including logged organization failures; directory failures return Left.
   * Captures the highest active organization ID once; IDs above it wait for the next run.
   * This method is not parallel safe. The caller must prevent overlapping executions across
   * all worker instances; this service does not acquire a lock for the scan.
   */
  relay(
    owner: string,
    batchSize: number = EVENTS_PER_ORGANIZATION
  ): TE.TaskEither<
    OrganizationSummaryValidationError | RepositoryDependencyError | "lease_invalid_owner" | "invalid_batch_size",
    void
  > {
    if (!owner.trim()) return TE.left("lease_invalid_owner")
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) return TE.left("invalid_batch_size")
    return pipe(
      this.organizationsRepo.getLastOrganizationId("active"),
      TE.chainW(throughId =>
        throughId === undefined ? TE.right(undefined) : this.scanOrganizations(owner, batchSize, throughId)
      )
    )
  }

  private scanOrganizations(
    owner: string,
    batchSize: number,
    throughId: string,
    afterId?: string
  ): TE.TaskEither<OrganizationSummaryValidationError | RepositoryDependencyError, void> {
    return pipe(
      this.organizationsRepo.listBatch(ORGANIZATIONS_PER_PAGE, afterId, "active", throughId),
      TE.chainW(organizations =>
        pipe(
          TE.traverseSeqArray((organization: OrganizationSummary) =>
            this.relayOrganization({organizationId: organization.id}, owner, batchSize)
          )(organizations),
          TE.chainW(() => {
            const lastOrganization = organizations.at(-1)
            if (organizations.length < ORGANIZATIONS_PER_PAGE || !lastOrganization || lastOrganization.id === throughId)
              return TE.right(undefined)
            return this.scanOrganizations(owner, batchSize, throughId, lastOrganization.id)
          })
        )
      )
    )
  }

  private relayOrganization(context: TenantContext, owner: string, batchSize: number): TE.TaskEither<never, void> {
    return pipe(
      this.workerOutbox.claim(context, outboxRecoveryCriteria(owner, new Date(), batchSize)),
      TE.orElseFirstIOK(
        error => () => Logger.error(`Outbox claim failed for organization ${context.organizationId}: ${error}`)
      ),
      TE.chainW(TE.traverseSeqArray(entry => this.publish(context, entry))),
      TE.map(() => undefined),
      // Keep scanning other organizations; the failed batch is recovered on a later relay.
      TE.orElse(() => TE.right(undefined))
    )
  }

  private publish(
    context: TenantContext,
    entry: OutboxClaim
  ): TE.TaskEither<WorkError | EnqueueTenantEventError, void> {
    return pipe(
      this.queue.enqueue(entry.event, entry.lease.fencing),
      TE.orElseFirstIOK(
        error => () => Logger.error(`Outbox publish failed for event ${entry.event.eventId}: ${error}`)
      ),
      TE.chainW(() =>
        pipe(
          this.workerOutbox.acknowledge(context, entry.event.eventId, entry.lease),
          TE.orElseFirstIOK(
            error => () => Logger.error(`Outbox acknowledgement failed for event ${entry.event.eventId}: ${error}`)
          )
        )
      )
    )
  }
}
