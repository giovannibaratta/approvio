import {Inject, Injectable} from "@nestjs/common"
import {
  Actor,
  AuditLogFactory,
  AuthenticatedEntity,
  MembershipStatus,
  MutationError,
  OrgRole,
  TenantContext,
  User,
  UserFactory
} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {AuditLogValidationError} from "@domain"
import {isUUIDv7, PaginationValidationError, validatePagination} from "@utils"
import {RepositoryDependencyError, UnknownError} from "../error"
import {AuditLogRepository, AUDIT_LOG_REPOSITORY_TOKEN} from "../audit-log/interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager, TransactionError} from "../transaction/interfaces"
import {
  MEMBERSHIP_REPOSITORY_TOKEN,
  MembershipRepository,
  TenantOperationError,
  VersionedMembership
} from "./interfaces"

export type MembershipManagementError =
  | TenantOperationError
  | MutationError
  | TransactionError
  | RepositoryDependencyError
  | UnknownError
  | AuditLogValidationError
  | PaginationValidationError

export interface RemoveMembershipRequest {
  readonly membershipId: string
  readonly expectedVersion: string
}

export interface ChangeMembershipRoleRequest extends RemoveMembershipRequest {
  readonly orgRole: OrgRole
}

@Injectable()
export class MembershipManagementService {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY_TOKEN) private readonly membershipRepo: MembershipRepository,
    @Inject(AUDIT_LOG_REPOSITORY_TOKEN) private readonly auditRepo: AuditLogRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly txManager: TenantTransactionManager
  ) {}

  list(
    context: TenantContext,
    requestor: AuthenticatedEntity,
    page: number,
    limit: number
  ): TE.TaskEither<
    MembershipManagementError,
    {readonly items: ReadonlyArray<VersionedMembership>; readonly total: number}
  > {
    return this.txManager.execute(context, () =>
      pipe(
        TE.fromEither(validatePagination(page, limit)),
        TE.chainW(() => this.requireManager(context, requestor)),
        TE.chainW(() => this.membershipRepo.list(context, page, limit))
      )
    )
  }

  changeRole(
    context: TenantContext,
    requestor: AuthenticatedEntity,
    request: ChangeMembershipRoleRequest
  ): TE.TaskEither<MembershipManagementError, VersionedMembership> {
    const {membershipId, orgRole, expectedVersion} = request
    if (!isUUIDv7(membershipId)) return TE.left("invalid_reference")
    return this.txManager.execute(
      context,
      () =>
        pipe(
          this.requireManager(context, requestor),
          TE.bindTo("actor"),
          TE.bindW("target", () => this.membershipRepo.getVersionedById(context, membershipId)),
          TE.chainFirstW(({actor, target}) => {
            if (target.membership.status !== MembershipStatus.ACTIVE) return TE.left("resource_not_found" as const)
            if (!UserFactory.canGrantOrgRole(actor, target.membership, orgRole))
              return TE.left("permission_denied" as const)
            if (target.membership.orgRole !== OrgRole.OWNER || orgRole === OrgRole.OWNER) return TE.right(undefined)
            return pipe(
              this.membershipRepo.countActiveOwners(context),
              TE.chainW(count => (count <= 1 ? TE.left("organization_owner_required" as const) : TE.right(undefined)))
            )
          }),
          TE.chainW(({actor, target}) => this.performRoleChange(context, actor, target, orgRole, expectedVersion))
        ),
      // Different membership OCC values cannot protect the shared active-owner count.
      {isolationLevel: "Serializable"}
    )
  }

  remove(
    context: TenantContext,
    requestor: AuthenticatedEntity,
    request: RemoveMembershipRequest
  ): TE.TaskEither<MembershipManagementError, void> {
    const {membershipId, expectedVersion} = request
    if (!isUUIDv7(membershipId)) return TE.left("invalid_reference")
    return this.txManager.execute(
      context,
      () =>
        pipe(
          this.requireManager(context, requestor),
          TE.bindTo("actor"),
          TE.bindW("target", () => this.membershipRepo.getVersionedById(context, membershipId)),
          TE.chainFirstW(({actor, target}) => {
            if (target.membership.status !== MembershipStatus.ACTIVE) return TE.left("resource_not_found" as const)
            if (!UserFactory.canGrantOrgRole(actor, target.membership, target.membership.orgRole))
              return TE.left("permission_denied" as const)
            if (target.membership.orgRole !== OrgRole.OWNER) return TE.right(undefined)
            return pipe(
              this.membershipRepo.countActiveOwners(context),
              TE.chainW(count => (count <= 1 ? TE.left("organization_owner_required" as const) : TE.right(undefined)))
            )
          }),
          TE.chainFirstW(() => this.membershipRepo.remove(context, membershipId, expectedVersion)),
          TE.chainW(({actor, target}) =>
            this.persistAudit(context, actor, "MEMBERSHIP_REMOVED", membershipId, {
              accountId: target.membership.accountId,
              orgRole: target.membership.orgRole
            })
          )
        ),
      // Different membership OCC values cannot protect the shared active-owner count.
      {isolationLevel: "Serializable"}
    )
  }

  private performRoleChange(
    context: TenantContext,
    actor: User,
    target: VersionedMembership,
    orgRole: OrgRole,
    expectedVersion: string
  ): TE.TaskEither<MembershipManagementError, VersionedMembership> {
    return pipe(
      this.membershipRepo.changeRole(context, target.membership.id, orgRole, expectedVersion),
      TE.chainFirstW(updated =>
        this.persistAudit(context, actor, "MEMBERSHIP_ROLE_CHANGED", updated.membership.id, {
          previousRole: target.membership.orgRole,
          orgRole
        })
      )
    )
  }

  private requireManager(
    context: TenantContext,
    requestor: AuthenticatedEntity
  ): TE.TaskEither<MembershipManagementError, User> {
    if (requestor.entityType !== "user" || requestor.user.organizationId !== context.organizationId)
      return TE.left("permission_denied")
    return requestor.user.status === MembershipStatus.ACTIVE &&
      (requestor.user.orgRole === OrgRole.OWNER || requestor.user.orgRole === OrgRole.ADMIN)
      ? TE.right(requestor.user)
      : TE.left("permission_denied")
  }

  private persistAudit(
    context: TenantContext,
    actor: User,
    auditType: "MEMBERSHIP_ROLE_CHANGED" | "MEMBERSHIP_REMOVED",
    membershipId: string,
    payload: Record<string, unknown>
  ): TE.TaskEither<MembershipManagementError, void> {
    const auditActor: Actor = {type: "user", id: actor.id, displayName: actor.displayName}
    return pipe(
      AuditLogFactory.create({
        organizationId: context.organizationId,
        auditType,
        entityType: "MEMBERSHIP",
        entityId: membershipId,
        actor: auditActor,
        payload
      }),
      TE.fromEither,
      TE.chainW(audit => this.auditRepo.persist(context, audit))
    )
  }
}
