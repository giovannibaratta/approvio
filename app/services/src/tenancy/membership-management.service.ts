import {Inject, Injectable} from "@nestjs/common"
import {
  Account,
  UserValidationError,
  MembershipTransitionError,
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

export type MembershipAdmissionError =
  | UserValidationError
  | MembershipTransitionError
  | MutationError
  | RepositoryDependencyError
  | TransactionError
  | "membership_already_active"

export type MembershipManagementError =
  | UserValidationError
  | MembershipTransitionError
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

  admit(
    context: TenantContext,
    account: Account,
    orgRole: OrgRole
  ): TE.TaskEither<MembershipAdmissionError, VersionedMembership> {
    return this.txManager.execute(context, () =>
      pipe(
        this.membershipRepo.getByAccount(context, account.id),
        TE.foldW(
          error => (error === "resource_not_found" ? this.createMembership(context, account, orgRole) : TE.left(error)),
          previous => this.readmitMembership(context, previous, orgRole)
        )
      )
    )
  }

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

  get(
    context: TenantContext,
    requestor: AuthenticatedEntity,
    membershipId: string
  ): TE.TaskEither<MembershipManagementError, VersionedMembership> {
    if (!isUUIDv7(membershipId)) return TE.left("invalid_reference")
    return this.txManager.execute(context, () =>
      pipe(
        this.requireManager(context, requestor),
        TE.chainW(() => this.membershipRepo.getById(context, membershipId))
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
          TE.bindW("target", () => this.membershipRepo.getById(context, membershipId)),
          TE.filterOrElseW(
            ({target}) => target.membership.status === MembershipStatus.ACTIVE,
            () => "resource_not_found" as const
          ),
          TE.filterOrElseW(
            ({actor, target}) => UserFactory.canGrantOrgRole(actor, target.membership, orgRole),
            () => "permission_denied" as const
          ),
          TE.chainFirstW(({target}) =>
            target.membership.orgRole === OrgRole.OWNER && orgRole !== OrgRole.OWNER
              ? this.requireAnotherActiveOwner(context)
              : TE.right(undefined)
          ),
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
          TE.bindW("target", () => this.membershipRepo.getById(context, membershipId)),
          TE.filterOrElseW(
            ({target}) => target.membership.status === MembershipStatus.ACTIVE,
            () => "resource_not_found" as const
          ),
          TE.filterOrElseW(
            ({actor, target}) => UserFactory.canGrantOrgRole(actor, target.membership, target.membership.orgRole),
            () => "permission_denied" as const
          ),
          TE.chainFirstW(({target}) =>
            target.membership.orgRole === OrgRole.OWNER ? this.requireAnotherActiveOwner(context) : TE.right(undefined)
          ),
          TE.bindW("removed", ({target}) => TE.fromEither(UserFactory.remove(target.membership))),
          TE.chainFirstW(({target, removed}) =>
            this.membershipRepo.update(context, {...target, occ: expectedVersion}, removed)
          ),
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

  private createMembership(
    context: TenantContext,
    account: Account,
    orgRole: OrgRole
  ): TE.TaskEither<MembershipAdmissionError, VersionedMembership> {
    return pipe(
      UserFactory.create({
        organizationId: context.organizationId,
        accountId: account.id,
        displayName: "Member",
        orgRole
      }),
      TE.fromEither,
      TE.chainW(membership => this.membershipRepo.create(context, membership))
    )
  }

  private readmitMembership(
    context: TenantContext,
    previous: VersionedMembership,
    orgRole: OrgRole
  ): TE.TaskEither<MembershipAdmissionError, VersionedMembership> {
    return pipe(
      UserFactory.readmit(previous.membership, orgRole),
      TE.fromEither,
      TE.chainW(membership => this.membershipRepo.update(context, previous, membership))
    )
  }

  private requireAnotherActiveOwner(context: TenantContext): TE.TaskEither<MembershipManagementError, void> {
    return pipe(
      this.membershipRepo.countActiveOwners(context),
      TE.filterOrElseW(
        count => count > 1,
        () => "organization_owner_required" as const
      ),
      TE.map(() => undefined)
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
      TE.fromEither(UserFactory.changeOrgRole(target.membership, orgRole)),
      TE.chainW(membership => this.membershipRepo.update(context, {...target, occ: expectedVersion}, membership)),
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
