import {Injectable} from "@nestjs/common"
import {Prisma} from "@prisma/client"
import {DatabaseClient, TenantContextRequiredError} from "./database-client"
import {transactionContext} from "./transaction-context"
import {EventReceiptConsumer, EventReceiptResult, recordTenantEventReceipt} from "./event-receipt-operation"

abstract class TenantDatabaseView<T> {
  protected constructor(
    private readonly databaseClient: DatabaseClient,
    private readonly project: (transaction: Prisma.TransactionClient, organizationId: string) => T
  ) {}

  get cx(): T {
    const activeContext = transactionContext.getStore()
    if (!activeContext || activeContext.runtimeRole !== this.databaseClient.runtimeRole)
      throw new TenantContextRequiredError()
    return this.project(activeContext.tx, activeContext.organizationId)
  }

  transactional<R>(
    organizationId: string,
    computation: (client: T) => Promise<R>,
    options?: {isolationLevel?: Prisma.TransactionIsolationLevel}
  ): Promise<R> {
    return this.databaseClient.transactional(
      organizationId,
      transaction => computation(this.project(transaction, organizationId)),
      options
    )
  }
}

@Injectable()
export class AgentChallengeTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "agentChallenge">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({agentChallenge: tx.agentChallenge}))
  }
}

@Injectable()
export class AgentTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "agent">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({agent: tx.agent}))
  }
}

@Injectable()
export class OrganizationProvisionerTenantClient extends TenantDatabaseView<
  Pick<Prisma.TransactionClient, "organization" | "user">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({organization: tx.organization, user: tx.user}))
  }
}

@Injectable()
export class AuditLogTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "auditLog">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({auditLog: tx.auditLog}))
  }
}

@Injectable()
export class GroupMembershipTenantClient extends TenantDatabaseView<
  Pick<Prisma.TransactionClient, "agentGroupMembership" | "group" | "groupMembership">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({
      agentGroupMembership: tx.agentGroupMembership,
      group: tx.group,
      groupMembership: tx.groupMembership
    }))
  }
}

@Injectable()
export class GroupTenantClient extends TenantDatabaseView<
  Pick<Prisma.TransactionClient, "group" | "groupMembership" | "user">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({group: tx.group, groupMembership: tx.groupMembership, user: tx.user}))
  }
}

@Injectable()
export class InvitationTenantClient extends TenantDatabaseView<
  Pick<Prisma.TransactionClient, "organizationInvitation">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({organizationInvitation: tx.organizationInvitation}))
  }
}

@Injectable()
export class LifecycleTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "organization">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({organization: tx.organization}))
  }
}

@Injectable()
export class MembershipTenantClient extends TenantDatabaseView<
  Pick<Prisma.TransactionClient, "groupMembership" | "user">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({groupMembership: tx.groupMembership, user: tx.user}))
  }
}

@Injectable()
export class OrganizationDirectoryTenantClient extends TenantDatabaseView<
  Pick<Prisma.TransactionClient, "organization">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({organization: tx.organization}))
  }
}

@Injectable()
export class QuotaTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "quota">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({quota: tx.quota}))
  }
}

@Injectable()
export class AgentRefreshTokenTenantClient extends TenantDatabaseView<
  Pick<Prisma.TransactionClient, "agentRefreshToken">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({agentRefreshToken: tx.agentRefreshToken}))
  }
}

@Injectable()
export class SpaceTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "space" | "user">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({space: tx.space, user: tx.user}))
  }
}

@Injectable()
export class StepUpReceiptTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "stepUpReceipt">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({stepUpReceipt: tx.stepUpReceipt}))
  }
}

@Injectable()
export class TenantOutboxTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "tenantOutbox">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({tenantOutbox: tx.tenantOutbox}))
  }
}

@Injectable()
export class EventReceiptTenantClient extends TenantDatabaseView<{
  record(consumer: EventReceiptConsumer, eventId: string): Promise<EventReceiptResult>
}> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, (tx, activeOrganizationId) => ({
      record: (consumer, eventId) => recordTenantEventReceipt(tx, activeOrganizationId, consumer, eventId)
    }))
  }
}

@Injectable()
export class UsageEventTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "usageEvent">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({usageEvent: tx.usageEvent}))
  }
}

@Injectable()
export class UsageOperationTenantClient extends TenantDatabaseView<
  Pick<Prisma.TransactionClient, "usageOperation" | "usageSettlementIntent" | "usageEvent">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({
      usageOperation: tx.usageOperation,
      usageSettlementIntent: tx.usageSettlementIntent,
      usageEvent: tx.usageEvent
    }))
  }
}

@Injectable()
export class UserTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "user">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({user: tx.user}))
  }
}

@Injectable()
export class VoteTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "vote" | "workflow">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({vote: tx.vote, workflow: tx.workflow}))
  }
}

@Injectable()
export class WorkflowTemplateTenantClient extends TenantDatabaseView<
  Pick<Prisma.TransactionClient, "workflowTemplate" | "group">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({workflowTemplate: tx.workflowTemplate, group: tx.group}))
  }
}

@Injectable()
export class WorkflowTenantClient extends TenantDatabaseView<WorkflowTenantClientView> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({
      workflow: tx.workflow,
      getDueExpirationSchedule: async (organizationId, dueBefore, scheduledBefore) => {
        const schedules = await tx.$queryRaw<Array<{readonly lastSweptAt: Date | null}>>`
          SELECT last_swept_at AS "lastSweptAt"
          FROM workflow_expiration_schedules
          WHERE organization_id = ${organizationId}::uuid
            AND next_sweep_at <= ${dueBefore}
            AND (last_scheduled_at IS NULL OR last_scheduled_at <= ${scheduledBefore})
        `
        return schedules[0] ?? null
      },
      claimExpirationSchedule: async (organizationId, scheduledAt, scheduledBefore) => {
        const claimed = await tx.$queryRaw<Array<{readonly organizationId: string}>>`
          UPDATE workflow_expiration_schedules
          SET last_scheduled_at = ${scheduledAt}
          WHERE organization_id = ${organizationId}::uuid
            AND next_sweep_at <= ${scheduledAt}
            AND (last_scheduled_at IS NULL OR last_scheduled_at <= ${scheduledBefore})
          RETURNING organization_id AS "organizationId"
        `
        return claimed.length > 0
      },
      // Lock the schedule row so a concurrent create cannot register an earlier deadline
      // between this workflow scan and the schedule update.
      completeExpirationSchedule: async (organizationId, sweptAt) => {
        await tx.$queryRaw<Array<{readonly organizationId: string}>>`
          SELECT organization_id AS "organizationId"
          FROM workflow_expiration_schedules
          WHERE organization_id = ${organizationId}::uuid
          FOR UPDATE
        `
        const [next] = await tx.$queryRaw<Array<{readonly nextSweepAt: Date | null}>>`
          SELECT MIN(expires_at) AS "nextSweepAt"
          FROM workflows
          WHERE organization_id = ${organizationId}::uuid
            AND status NOT IN ('APPROVED', 'CANCELED', 'EXPIRED')
            AND recalculation_required = false
        `
        await tx.$executeRaw`
          UPDATE workflow_expiration_schedules
          SET next_sweep_at = ${next?.nextSweepAt ?? null}, last_swept_at = ${sweptAt}
          WHERE organization_id = ${organizationId}::uuid
        `
      },
      registerWorkflowExpiration: async (organizationId, expiresAt) => {
        await tx.$executeRaw`
          INSERT INTO workflow_expiration_schedules (organization_id, next_sweep_at)
          VALUES (${organizationId}::uuid, ${expiresAt})
          ON CONFLICT (organization_id) DO UPDATE
          SET next_sweep_at = EXCLUDED.next_sweep_at
          WHERE workflow_expiration_schedules.next_sweep_at IS NULL
             OR workflow_expiration_schedules.next_sweep_at > EXCLUDED.next_sweep_at
        `
      }
    }))
  }
}

interface WorkflowTenantClientView extends Pick<Prisma.TransactionClient, "workflow"> {
  getDueExpirationSchedule(
    organizationId: string,
    dueBefore: Date,
    scheduledBefore: Date
  ): Promise<{readonly lastSweptAt: Date | null} | null>
  claimExpirationSchedule(organizationId: string, scheduledAt: Date, scheduledBefore: Date): Promise<boolean>
  completeExpirationSchedule(organizationId: string, sweptAt: Date): Promise<void>
  registerWorkflowExpiration(organizationId: string, expiresAt: Date): Promise<void>
}
