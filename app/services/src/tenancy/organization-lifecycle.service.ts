import {
  OrganizationFactory,
  OrganizationValidationError,
  OrganizationTransitionError,
  Actor,
  AuditLogFactory,
  AuthenticatedEntity,
  MembershipStatus,
  MutationError,
  OrgRole,
  StepUpReceiptClaim,
  StepUpReceiptFactory,
  TenantContext,
  User
} from "@domain"
import {TenantOperationError, OrganizationSummary} from "./interfaces"
import {Inject, Injectable} from "@nestjs/common"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {RepositoryDependencyError, UnknownError} from "../error"
import {AuditLogRepository, AUDIT_LOG_REPOSITORY_TOKEN} from "../audit-log/interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager, TransactionError} from "../transaction/interfaces"
import {
  LIFECYCLE_REPOSITORY_TOKEN,
  LifecycleRepository,
  STEP_UP_RECEIPT_REPOSITORY_TOKEN,
  StepUpReceiptRepository
} from "./interfaces"
import {AuditLogValidationError, BoundaryError, RoleValidationError} from "@domain"

export type OrganizationLifecycleError =
  | OrganizationValidationError
  | OrganizationTransitionError
  | TenantOperationError
  | MutationError
  | RepositoryDependencyError
  | TransactionError
  | UnknownError
  | AuditLogValidationError
  | RoleValidationError
  | "step_up_context_missing"
  | "step_up_operation_mismatch"
  | "step_up_resource_mismatch"
  | "event_mismatch"
  | BoundaryError

@Injectable()
export class OrganizationLifecycleService {
  constructor(
    @Inject(LIFECYCLE_REPOSITORY_TOKEN) private readonly lifecycleRepo: LifecycleRepository,
    @Inject(STEP_UP_RECEIPT_REPOSITORY_TOKEN) private readonly stepUpReceiptRepo: StepUpReceiptRepository,
    @Inject(AUDIT_LOG_REPOSITORY_TOKEN) private readonly auditLogRepo: AuditLogRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly txManager: TenantTransactionManager
  ) {}

  suspend(
    context: TenantContext,
    requestor: AuthenticatedEntity,
    expectedVersion: bigint
  ): TE.TaskEither<OrganizationLifecycleError, OrganizationSummary> {
    return this.transition(context, requestor, expectedVersion, {status: "suspended", reason: "owner_requested"})
  }

  resume(
    context: TenantContext,
    requestor: AuthenticatedEntity,
    expectedVersion: bigint
  ): TE.TaskEither<OrganizationLifecycleError, OrganizationSummary> {
    return this.txManager.execute(context, () =>
      pipe(
        this.requireActiveOwner(context, requestor),
        TE.bindTo("owner"),
        TE.bindW("updated", () => this.applyTransition(context, expectedVersion, {status: "active"})),
        TE.chainFirstW(({owner, updated}) =>
          this.persistAudit(context, owner, "ORGANIZATION_RESUMED", updated, {status: updated.status})
        ),
        TE.map(({updated}) => updated)
      )
    )
  }

  requestDeletion(
    context: TenantContext,
    requestor: AuthenticatedEntity,
    expectedVersion: bigint
  ): TE.TaskEither<OrganizationLifecycleError, OrganizationSummary> {
    return this.txManager.execute(context, () =>
      pipe(
        this.requireActiveOwner(context, requestor),
        TE.bindTo("owner"),
        TE.chainFirstW(({owner}) => this.validateAndConsumeDeletionStepUp(context, owner, requestor)),
        TE.bindW("updated", () => this.applyTransition(context, expectedVersion, {status: "deleting"})),
        TE.chainFirstW(({owner, updated}) =>
          this.persistAudit(context, owner, "ORGANIZATION_DELETION_REQUESTED", updated, {status: updated.status})
        ),
        TE.map(({updated}) => updated)
      )
    )
  }

  private transition(
    context: TenantContext,
    requestor: AuthenticatedEntity,
    expectedVersion: bigint,
    input: {readonly status: "suspended"; readonly reason: "owner_requested"}
  ): TE.TaskEither<OrganizationLifecycleError, OrganizationSummary> {
    return this.txManager.execute(context, () =>
      pipe(
        this.requireActiveOwner(context, requestor),
        TE.bindTo("owner"),
        TE.bindW("updated", () => this.applyTransition(context, expectedVersion, input)),
        TE.chainFirstW(({owner, updated}) =>
          this.persistAudit(context, owner, "ORGANIZATION_SUSPENDED", updated, {
            status: updated.status,
            reason: input.reason
          })
        ),
        TE.map(({updated}) => updated)
      )
    )
  }

  private applyTransition(
    context: TenantContext,
    expectedVersion: bigint,
    input: Parameters<typeof OrganizationFactory.transition>[1]
  ): TE.TaskEither<OrganizationLifecycleError, OrganizationSummary> {
    return pipe(
      this.lifecycleRepo.get(context),
      TE.chainEitherKW(organization => OrganizationFactory.transition(organization, input, "owner")),
      TE.chainW(organization => this.lifecycleRepo.persistTransition(context, expectedVersion, organization))
    )
  }

  private requireActiveOwner(
    context: TenantContext,
    requestor: AuthenticatedEntity
  ): TE.TaskEither<OrganizationLifecycleError, User> {
    if (requestor.entityType !== "user" || requestor.user.organizationId !== context.organizationId)
      return TE.left("permission_denied")
    return requestor.user.status === MembershipStatus.ACTIVE && requestor.user.orgRole === OrgRole.OWNER
      ? TE.right(requestor.user)
      : TE.left("permission_denied")
  }

  private validateAndConsumeDeletionStepUp(
    context: TenantContext,
    owner: User,
    requestor: AuthenticatedEntity
  ): TE.TaskEither<OrganizationLifecycleError, void> {
    if (!requestor || requestor.entityType !== "user") return TE.left("step_up_context_missing")
    const stepUp = requestor.authContext
    if (!stepUp) return TE.left("step_up_context_missing")
    if (stepUp.operation !== "delete_organization") return TE.left("step_up_operation_mismatch")
    if (stepUp.resource !== context.organizationId) return TE.left("step_up_resource_mismatch")

    const receipt: StepUpReceiptClaim = {
      organizationId: context.organizationId,
      jti: stepUp.jti,
      userId: owner.id,
      sessionId: requestor.sessionId,
      providerId: requestor.providerId,
      contextVersion: requestor.sessionContextVersion,
      operation: stepUp.operation,
      resourceId: context.organizationId
    }
    return pipe(
      this.stepUpReceiptRepo.get(context, receipt.jti),
      TE.chainEitherKW(stored => StepUpReceiptFactory.consume(stored, receipt)),
      TE.chainW(consumed => this.stepUpReceiptRepo.persist(context, consumed))
    )
  }

  private persistAudit(
    context: TenantContext,
    owner: User,
    auditType: "ORGANIZATION_SUSPENDED" | "ORGANIZATION_RESUMED" | "ORGANIZATION_DELETION_REQUESTED",
    organization: OrganizationSummary,
    payload: Record<string, unknown>
  ): TE.TaskEither<OrganizationLifecycleError, void> {
    const actor: Actor = {type: "user", id: owner.id, displayName: owner.displayName}
    return pipe(
      AuditLogFactory.create({
        organizationId: context.organizationId,
        auditType,
        entityType: "ORGANIZATION",
        entityId: organization.id,
        actor,
        payload
      }),
      TE.fromEither,
      TE.chainW(log => this.auditLogRepo.persist(context, log))
    )
  }
}
