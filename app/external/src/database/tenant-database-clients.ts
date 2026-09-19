import {Injectable} from "@nestjs/common"
import {Prisma} from "@prisma/client"
import {DatabaseClient, TenantContextRequiredError} from "./database-client"
import {transactionContext} from "./transaction-context"

abstract class TenantDatabaseView<T> {
  protected constructor(
    private readonly databaseClient: DatabaseClient,
    private readonly project: (transaction: Prisma.TransactionClient) => T
  ) {}

  get cx(): T {
    const activeContext = transactionContext.getStore()
    if (!activeContext) throw new TenantContextRequiredError()
    return this.project(activeContext.tx)
  }

  transactional<R>(organizationId: string, computation: (client: T) => Promise<R>): Promise<R> {
    return this.databaseClient.transactional(organizationId, transaction => computation(this.project(transaction)))
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
  Pick<Prisma.TransactionClient, "$queryRaw" | "organizationInvitation">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({$queryRaw: tx.$queryRaw.bind(tx), organizationInvitation: tx.organizationInvitation}))
  }
}

@Injectable()
export class LifecycleTenantClient extends TenantDatabaseView<
  Pick<Prisma.TransactionClient, "$queryRaw" | "organization">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({$queryRaw: tx.$queryRaw.bind(tx), organization: tx.organization}))
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
export class UsageEventTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "usageEvent">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({usageEvent: tx.usageEvent}))
  }
}

@Injectable()
export class UsageOperationTenantClient extends TenantDatabaseView<
  Pick<Prisma.TransactionClient, "usageOperation" | "usageSettlementIntent">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({usageOperation: tx.usageOperation, usageSettlementIntent: tx.usageSettlementIntent}))
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
  Pick<Prisma.TransactionClient, "workflowTemplate">
> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({workflowTemplate: tx.workflowTemplate}))
  }
}

@Injectable()
export class WorkflowTenantClient extends TenantDatabaseView<Pick<Prisma.TransactionClient, "workflow">> {
  constructor(databaseClient: DatabaseClient) {
    super(databaseClient, tx => ({workflow: tx.workflow}))
  }
}
