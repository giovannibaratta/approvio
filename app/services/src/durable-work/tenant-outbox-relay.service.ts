import {WORKER_TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "../transaction/interfaces"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {isLeft} from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {OrganizationDirectoryRepository, ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN} from "../tenancy/interfaces"
import {OUTBOX_REPOSITORY_TOKEN, OutboxRepository} from "./interfaces"
import {TenantOutboxService} from "./tenant-outbox.service"
import {outboxRecoveryCriteria} from "./tenant-outbox.utils"
import {QueueService} from "../queue/queue.service"

const ORGANIZATIONS_PER_PAGE = 50
const EVENTS_PER_ORGANIZATION = 10

@Injectable()
export class TenantOutboxRelayService {
  constructor(
    private readonly tenantOutbox: TenantOutboxService,
    @Inject(ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN)
    private readonly organizations: OrganizationDirectoryRepository,
    @Inject(OUTBOX_REPOSITORY_TOKEN)
    private readonly outbox: OutboxRepository,
    private readonly queue: QueueService,
    @Inject(WORKER_TRANSACTION_MANAGER_TOKEN) private readonly workerTransactions: TenantTransactionManager
  ) {}

  relay(
    owner: string,
    batchSize: number = EVENTS_PER_ORGANIZATION
  ): TE.TaskEither<"unknown_error" | "lease_invalid_owner" | "invalid_batch_size", void> {
    if (!owner.trim()) return TE.left("lease_invalid_owner")
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) return TE.left("invalid_batch_size")
    return TE.tryCatch(
      async () => {
        let afterId: string | undefined
        while (true) {
          const listed = await this.organizations.listBatch(ORGANIZATIONS_PER_PAGE, afterId)()
          if (isLeft(listed)) throw new Error(`Organization scan failed: ${listed.left}`)

          for (const organization of listed.right) {
            if (organization.status !== "active") continue

            const context = {organizationId: organization.id}
            const criteria = outboxRecoveryCriteria(owner, new Date(), batchSize)
            const claimed = await this.workerTransactions.execute(context, () => this.outbox.claim(context, criteria))()
            if (isLeft(claimed)) {
              Logger.error(`Outbox claim failed for organization ${organization.id}: ${claimed.left}`)
              continue
            }

            for (const entry of claimed.right) {
              const published = await this.queue.enqueue(entry.event, Number(entry.lease.fencing))()
              if (isLeft(published)) {
                Logger.error(`Outbox publish failed for event ${entry.event.eventId}: ${published.left}`)
                break
              }

              const acknowledged = await this.tenantOutbox.acknowledge(context, entry.event.eventId, entry.lease)()
              if (isLeft(acknowledged)) {
                Logger.error(`Outbox acknowledgement failed for event ${entry.event.eventId}: ${acknowledged.left}`)
                break
              }
            }
          }

          const lastOrganization = listed.right.at(-1)
          if (listed.right.length < ORGANIZATIONS_PER_PAGE || !lastOrganization) return
          afterId = lastOrganization.id
        }
      },
      error => {
        Logger.error("Tenant outbox relay failed", error instanceof Error ? error.message : "non_error")
        return "unknown_error"
      }
    )
  }
}
