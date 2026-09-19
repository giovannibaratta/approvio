import {Inject, Injectable} from "@nestjs/common"
import {
  OriginatingActor,
  Account,
  AuditLogFactory,
  AuthenticatedEntity,
  InvitationFactory,
  InvitationValidationError,
  MembershipStatus,
  MutationError,
  OrgRole,
  TenantContext,
  User,
  UserValidationError,
  MembershipTransitionError
} from "@domain"
import {isUUIDv7} from "@utils"
import {pipe} from "fp-ts/function"
import {inTransaction} from "../transaction/in-transaction"
import * as TE from "fp-ts/TaskEither"
import {MembershipManagementService} from "./membership-management.service"
import {AuditLogValidationError} from "@domain"
import {RepositoryDependencyError, UnknownError} from "../error"
import {AuditLogRepository, AUDIT_LOG_REPOSITORY_TOKEN} from "../audit-log/interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager, TransactionError} from "../transaction/interfaces"
import {
  TenantOperationError,
  INVITATION_REPOSITORY_TOKEN,
  InvitationRepository,
  MEMBERSHIP_REPOSITORY_TOKEN,
  MembershipRepository
} from "./interfaces"

export type InvitationManagementError =
  | "membership_already_active"
  | InvitationValidationError
  | UserValidationError
  | MembershipTransitionError
  | TenantOperationError
  | MutationError
  | TransactionError
  | RepositoryDependencyError
  | UnknownError
  | AuditLogValidationError
  | "invitation_invalid"

export interface CreatedInvitation {
  readonly id: string
  readonly expiresAt: Date
  readonly token: string
}

export interface CreateInvitationRequest {
  readonly context: TenantContext
  readonly requestor: AuthenticatedEntity
  readonly accountId: string
  readonly orgRole: OrgRole
}

@Injectable()
export class InvitationManagementService {
  constructor(
    private readonly memberships: MembershipManagementService,
    @Inject(MEMBERSHIP_REPOSITORY_TOKEN) private readonly membershipRepo: MembershipRepository,
    @Inject(INVITATION_REPOSITORY_TOKEN) private readonly invitationRepo: InvitationRepository,
    @Inject(AUDIT_LOG_REPOSITORY_TOKEN) private readonly auditRepo: AuditLogRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly txManager: TenantTransactionManager
  ) {}

  create({
    context,
    requestor,
    accountId,
    orgRole
  }: CreateInvitationRequest): TE.TaskEither<InvitationManagementError, CreatedInvitation> {
    if (requestor.entityType !== "user" || requestor.user.organizationId !== context.organizationId)
      return TE.left("permission_denied")
    return pipe(
      InvitationFactory.create({
        organizationId: context.organizationId,
        inviteeAccountId: accountId,
        inviterUserId: requestor.user.id,
        orgRole
      }),
      TE.fromEither,
      inTransaction(this.txManager, context, ({invitation, token}) =>
        pipe(
          this.requireManager(context, requestor),
          TE.filterOrElseW(
            actor => InvitationFactory.canGrant(actor.orgRole, orgRole),
            () => "permission_denied" as const
          ),
          TE.chainFirstW(() => this.invitationRepo.create(context, invitation)),
          TE.chainFirstW(actor =>
            this.persistAudit(
              context,
              {type: "user", id: actor.id, displayName: actor.displayName},
              "INVITATION_CREATED",
              invitation.id,
              {accountId, orgRole, expiresAt: invitation.expiresAt.toISOString()}
            )
          ),
          TE.map(() => ({id: invitation.id, expiresAt: invitation.expiresAt, token}))
        )
      )
    )
  }

  revoke(
    context: TenantContext,
    requestor: AuthenticatedEntity,
    invitationId: string
  ): TE.TaskEither<InvitationManagementError, void> {
    if (!isUUIDv7(invitationId)) return TE.left("invalid_reference")
    return this.txManager.execute(context, () =>
      pipe(
        this.requireManager(context, requestor),
        TE.bindTo("actor"),
        TE.bindW("invitation", () => this.invitationRepo.getById(context, invitationId)),
        TE.bindW("revoked", ({actor, invitation}) => TE.fromEither(InvitationFactory.revoke(invitation, actor))),
        TE.chainFirstW(({invitation, revoked}) => this.invitationRepo.persist(context, revoked, invitation.occ)),
        TE.chainW(({actor}) =>
          this.persistAudit(
            context,
            {type: "user", id: actor.id, displayName: actor.displayName},
            "INVITATION_REVOKED",
            invitationId,
            {}
          )
        )
      )
    )
  }

  accept(
    context: TenantContext,
    account: Account,
    invitationId: string,
    token: string
  ): TE.TaskEither<InvitationManagementError, User> {
    if (!isUUIDv7(invitationId)) return TE.left("invitation_invalid")
    return this.txManager.execute(context, () =>
      pipe(
        this.invitationRepo.getById(context, invitationId),
        TE.bindTo("invitation"),
        TE.bindW("inviter", ({invitation}) => this.membershipRepo.getById(context, invitation.inviterUserId)),
        TE.bindW("accepted", ({invitation, inviter}) =>
          TE.fromEither(InvitationFactory.accept(invitation, account, inviter.membership, token))
        ),
        TE.bindW("admission", ({invitation}) => this.memberships.admit(context, account, invitation.orgRole)),
        TE.chainFirstW(({accepted, invitation}) => this.invitationRepo.persist(context, accepted, invitation.occ)),
        TE.chainFirstW(({admission: {membership}}) =>
          this.persistAudit(
            context,
            {type: "user", id: membership.id, displayName: membership.displayName},
            "INVITATION_ACCEPTED",
            invitationId,
            {membershipId: membership.id}
          )
        ),
        TE.map(({admission}) => admission.membership)
      )
    )
  }

  private requireManager(
    context: TenantContext,
    requestor: AuthenticatedEntity
  ): TE.TaskEither<InvitationManagementError, User> {
    if (requestor.entityType !== "user" || requestor.user.organizationId !== context.organizationId)
      return TE.left("permission_denied")
    return requestor.user.status === MembershipStatus.ACTIVE &&
      (requestor.user.orgRole === OrgRole.OWNER || requestor.user.orgRole === OrgRole.ADMIN)
      ? TE.right(requestor.user)
      : TE.left("permission_denied")
  }

  private persistAudit(
    context: TenantContext,
    actor: OriginatingActor,
    auditType: "INVITATION_CREATED" | "INVITATION_REVOKED" | "INVITATION_ACCEPTED",
    invitationId: string,
    payload: Record<string, unknown>
  ): TE.TaskEither<InvitationManagementError, void> {
    return pipe(
      AuditLogFactory.create({
        organizationId: context.organizationId,
        auditType,
        entityType: "INVITATION",
        entityId: invitationId,
        actor,
        payload
      }),
      TE.fromEither,
      TE.chainW(audit => this.auditRepo.persist(context, audit))
    )
  }
}
