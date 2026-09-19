import {Inject, Injectable} from "@nestjs/common"
import {
  OrganizationFactory,
  Organization,
  Versioned,
  OrganizationValidationError,
  OrganizationTransitionError,
  Actor,
  AuditLogFactory,
  PlatformSecurityEventFactory,
  SuspensionReason,
  TenantContext,
  MutationError,
  AuditLogValidationError,
  PlatformSecurityEventValidationError
} from "@domain"
import {isUUIDv7} from "@utils"
import {v7 as uuidv7} from "uuid"
import {pipe} from "fp-ts/function"
import {inTransaction} from "../transaction/in-transaction"
import * as TE from "fp-ts/TaskEither"
import {AuditLogRepository, AUDIT_LOG_REPOSITORY_TOKEN} from "../audit-log/interfaces"
import {
  PlatformSecurityEventRepository,
  PLATFORM_SECURITY_EVENT_REPOSITORY_TOKEN
} from "../platform-security/interfaces"
import {RepositoryDependencyError, UnknownError} from "../error"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager, TransactionError} from "../transaction/interfaces"
import {LIFECYCLE_REPOSITORY_TOKEN, LifecycleRepository, OrganizationSummary} from "./interfaces"

export type OperatorRecoveryError =
  | OrganizationValidationError
  | OrganizationTransitionError
  | MutationError
  | RepositoryDependencyError
  | TransactionError
  | UnknownError
  | AuditLogValidationError
  | PlatformSecurityEventValidationError

type LifecycleAction =
  | {readonly action: "suspend"; readonly reason: SuspensionReason}
  | {readonly action: "resume"; readonly reason: string}
  | {readonly action: "set_grace"; readonly dueAt?: Date; readonly reason: string}

@Injectable()
export class OperatorRecoveryService {
  constructor(
    @Inject(LIFECYCLE_REPOSITORY_TOKEN) private readonly lifecycleRepo: LifecycleRepository,
    @Inject(AUDIT_LOG_REPOSITORY_TOKEN) private readonly auditRepo: AuditLogRepository,
    @Inject(PLATFORM_SECURITY_EVENT_REPOSITORY_TOKEN) private readonly securityEvents: PlatformSecurityEventRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly txManager: TenantTransactionManager
  ) {}

  /** The caller must authenticate the operator; Actor supplies audit attribution only. */
  setLifecycle(
    operator: Actor,
    context: TenantContext,
    input: LifecycleAction
  ): TE.TaskEither<OperatorRecoveryError, OrganizationSummary> {
    if (
      !isOperator(operator) ||
      !validReason(input.reason) ||
      (input.action === "set_grace" && input.dueAt !== undefined && Number.isNaN(input.dueAt.getTime()))
    )
      return TE.left("invalid_reference")
    return pipe(
      this.recordOperatorAction({
        id: uuidv7(),
        actor: operator,
        occurredAt: new Date(),
        organizationId: context.organizationId,
        ...(input.action === "suspend"
          ? {type: "organization.suspended" as const, reason: input.reason}
          : input.action === "resume"
            ? {type: "organization.resumed" as const, reason: input.reason}
            : {type: "organization.grace_period_changed" as const, dueAt: input.dueAt, reason: input.reason})
      }),
      inTransaction(this.txManager, context, () =>
        pipe(
          this.lifecycleRepo.get(context),
          TE.chainW(organization => this.applyLifecycleChange(context, organization, input)),
          TE.chainFirstW(updated =>
            this.persistTenantAudit(
              context,
              operator,
              input.action === "suspend"
                ? "ORGANIZATION_SUSPENDED"
                : input.action === "resume"
                  ? "ORGANIZATION_RESUMED"
                  : "ORGANIZATION_UPDATED",
              updated.id,
              input.action === "set_grace"
                ? {graceUntil: input.dueAt?.toISOString(), reason: input.reason}
                : {status: updated.status, reason: input.reason}
            )
          )
        )
      )
    )
  }

  private applyLifecycleChange(
    context: TenantContext,
    organization: Versioned<Organization>,
    input: LifecycleAction
  ): TE.TaskEither<OperatorRecoveryError, OrganizationSummary> {
    return pipe(
      input.action === "set_grace"
        ? OrganizationFactory.setGracePeriod(organization, input.dueAt)
        : OrganizationFactory.transition(
            organization,
            input.action === "suspend" ? {status: "suspended", reason: input.reason} : {status: "active"},
            "operator"
          ),
      TE.fromEither,
      TE.chainW(updated => this.lifecycleRepo.persistTransition(context, organization.occ, updated))
    )
  }

  private recordOperatorAction(event: unknown): TE.TaskEither<OperatorRecoveryError, void> {
    return pipe(
      PlatformSecurityEventFactory.validate(event),
      TE.fromEither,
      TE.chainW(validatedEvent => this.securityEvents.append(validatedEvent))
    )
  }

  private persistTenantAudit(
    context: TenantContext,
    operator: Extract<Actor, {readonly type: "operator"}>,
    auditType: "ORGANIZATION_SUSPENDED" | "ORGANIZATION_RESUMED" | "ORGANIZATION_UPDATED",
    entityId: string,
    payload: Record<string, unknown>
  ): TE.TaskEither<OperatorRecoveryError, void> {
    const audit = AuditLogFactory.create({
      organizationId: context.organizationId,
      auditType,
      entityType: "ORGANIZATION",
      entityId,
      actor: operator,
      payload
    })
    return pipe(
      audit,
      TE.fromEither,
      TE.chainW(audit => this.auditRepo.persist(context, audit))
    )
  }
}

function isOperator(actor: Actor): actor is Extract<Actor, {type: "operator"}> {
  return actor.type === "operator" && isUUIDv7(actor.id) && actor.displayName.trim().length > 0
}

function validReason(reason: string): boolean {
  return reason.trim().length > 0 && reason.trim().length <= 500
}
