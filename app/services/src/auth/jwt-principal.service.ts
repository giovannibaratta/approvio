import {
  AuthenticatedAgent,
  AuthenticatedPlatformSession,
  AuthenticatedUser,
  AuthorityError,
  MembershipStatus,
  isOrganizationId,
  MutationError,
  TenantContext
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {AgentService} from "@services/agent"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager, TransactionError} from "@services/transaction/interfaces"
import {
  MEMBERSHIP_REPOSITORY_TOKEN,
  MembershipRepository,
  PLATFORM_IDENTITY_REPOSITORY_TOKEN,
  PlatformIdentityRepository,
  SESSION_REPOSITORY_TOKEN,
  SessionRepository
} from "../tenancy/interfaces"
import {AgentTokenPayload, PlatformTokenPayload, UserTokenPayload} from "./auth-token"
import {RepositoryDependencyError} from "../error"
import {AgentGetError} from "../agent/interfaces"

export type JwtPrincipalResolutionError =
  | "account_not_found"
  | "invalid_session"
  | "agent_revoked"
  | AuthorityError
  | MutationError
  | RepositoryDependencyError
  | AgentGetError
  | TransactionError
export type PlatformSessionResolutionError =
  "account_not_found" | "invalid_session" | AuthorityError | RepositoryDependencyError

/**
 * Turns a validated JWT payload into the current application principal.
 * "Resolve" means loading the referenced account, session, membership, or agent
 * and checking that they still match the token. A valid JWT alone does not
 * establish that its session or tenant membership is still current.
 *
 * It accepts a payload whose signature and time claims have already been
 * validated. It does not decide whether the principal may perform an operation.
 */
@Injectable()
export class JwtPrincipalService {
  constructor(
    private readonly agentService: AgentService,
    @Inject(PLATFORM_IDENTITY_REPOSITORY_TOKEN)
    private readonly platformIdentity: PlatformIdentityRepository,
    @Inject(SESSION_REPOSITORY_TOKEN)
    private readonly sessions: SessionRepository,
    @Inject(MEMBERSHIP_REPOSITORY_TOKEN)
    private readonly memberships: MembershipRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN)
    private readonly transactions: TenantTransactionManager
  ) {}

  resolveUser(payload: UserTokenPayload): TE.TaskEither<JwtPrincipalResolutionError, AuthenticatedUser> {
    return pipe(
      this.platformIdentity.getAccountById(payload.accountId),
      TE.chainW(account =>
        account.status === "active"
          ? this.sessions.getByAccountAndPrincipal(payload.accountId, payload.sessionId)
          : TE.left("invalid_session" as const)
      ),
      TE.chainW(session => {
        const organizationId = session.selectedOrganizationId
        if (session.providerId !== payload.providerId) return TE.left("invalid_session" as const)
        if (session.contextVersion !== BigInt(payload.sessionContextVersion))
          return TE.left("organization_context_changed" as const)
        if (!isOrganizationId(organizationId)) return TE.left("invalid_organization_id" as const)

        return TE.right({session, organizationId})
      }),
      TE.bindW("user", ({organizationId}) => {
        const context: TenantContext = {organizationId}
        return pipe(
          this.transactions.execute(context, () => this.memberships.getById(context, payload.sub)),
          TE.map(({membership}) => membership)
        )
      }),
      TE.chainW(({session, user}) => {
        if (user.status !== MembershipStatus.ACTIVE) return TE.left("resource_not_found" as const)
        if (user.accountId !== payload.accountId) return TE.left("invalid_session" as const)
        return TE.right({
          entityType: "user" as const,
          user,
          providerId: payload.providerId,
          sessionId: payload.sessionId,
          sessionContextVersion: session.contextVersion
        })
      })
    )
  }

  resolveAgent(payload: AgentTokenPayload): TE.TaskEither<JwtPrincipalResolutionError, AuthenticatedAgent> {
    if (!isOrganizationId(payload.organizationId)) return TE.left("invalid_credential")
    const context: TenantContext = {organizationId: payload.organizationId}
    return pipe(
      this.transactions.execute(context, () => this.agentService.getAgentById(context, payload.sub)),
      TE.chainW(agent =>
        agent.status === "active" ? TE.right({entityType: "agent" as const, agent}) : TE.left("agent_revoked" as const)
      )
    )
  }

  resolvePlatformSession(
    payload: PlatformTokenPayload
  ): TE.TaskEither<PlatformSessionResolutionError, AuthenticatedPlatformSession> {
    return pipe(
      this.platformIdentity.getAccountById(payload.sub),
      TE.bindTo("account"),
      TE.bindW("session", () => this.sessions.getByAccountAndPrincipal(payload.sub, payload.sessionId)),
      TE.chainW(({account, session}) => {
        if (
          session.providerId !== payload.providerId ||
          session.contextVersion !== BigInt(payload.sessionContextVersion)
        )
          return TE.left("invalid_session" as const)

        return TE.right({
          entityType: "platform" as const,
          account,
          sessionId: session.id,
          providerId: session.providerId,
          sessionContextVersion: session.contextVersion
        })
      })
    )
  }
}
