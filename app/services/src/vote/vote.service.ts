import {
  MembershipValidationErrorWithGroupRef,
  MembershipWithGroupRef,
  Vote,
  VoteFactory,
  CantVoteReason,
  canVoteOnWorkflow,
  UserValidationError,
  AgentValidationError,
  AuthenticatedEntity,
  TenantContext,
  createEntityReference,
  getEntityRoles
} from "@domain"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {UnknownError, AuthorizationError} from "@services/error"
import {RequestorAwareRequest} from "@services/shared/types"
import {AgentKeyDecodeError} from "@services/agent/interfaces"
import {WorkflowGetError, WorkflowUpdateError} from "../workflow/interfaces"
import {WorkflowService} from "../workflow/workflow.service"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {TaskEither} from "fp-ts/TaskEither"
import {PersistVoteError, GetLatestVoteError, VOTE_REPOSITORY_TOKEN, VoteRepository, FindVotesError} from "./interfaces"
import {sequenceS} from "fp-ts/Apply"
import {GROUP_MEMBERSHIP_REPOSITORY_TOKEN, GroupMembershipRepository} from "@services/group-membership"
import {isNone, Option} from "fp-ts/Option"
import {bestEffort, DistributiveOmit, logSuccess} from "@utils"
import {AuthService} from "@services/auth/auth.service"
import {UseHighPrivilegeTokenError} from "@services/auth/interfaces"
import {QuotaService} from "@services/quota/quota.service"
import {ExecutionError, TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import {inTransaction} from "@services/transaction/in-transaction"
import {OUTBOX_REPOSITORY_TOKEN, OutboxRepository} from "@services/durable-work/interfaces"
import {generateDeterministicId} from "@utils"
import {TenantEvent} from "@domain"
import {QueueService} from "@services/queue"
import {TenantOperationError} from "../tenancy/interfaces"

@Injectable()
export class VoteService {
  constructor(
    @Inject(VOTE_REPOSITORY_TOKEN)
    private readonly voteRepo: VoteRepository,
    private readonly workflowService: WorkflowService,
    @Inject(GROUP_MEMBERSHIP_REPOSITORY_TOKEN)
    private readonly groupMembershipRepo: GroupMembershipRepository,
    private readonly authService: AuthService,
    private readonly quotaService: QuotaService,
    @Inject(TRANSACTION_MANAGER_TOKEN)
    private readonly transactionManager: TenantTransactionManager,
    @Inject(OUTBOX_REPOSITORY_TOKEN)
    private readonly outboxRepository: OutboxRepository,
    private readonly queueService: QueueService
  ) {}

  /**
   * Checks if a user is eligible to vote on a workflow and their current voting status.
   * @param request The request containing the workflowId and the requestor.
   * @returns A TaskEither with the user's eligibility and status, or an error.
   */
  canVote(request: CanVoteRequest): TaskEither<CanVoteError, CanVoteResponse> {
    return this.transactionManager.execute<CanVoteError, CanVoteResponse>(request, () =>
      pipe(
        TE.Do,
        TE.bindW("workflowId", () => TE.right(request.workflowId)),
        TE.bindW("scope", ({workflowId}) =>
          sequenceS(TE.ApplicativePar)({
            workflowWithTemplate: this.workflowService.getWorkflowByIdentifier(request, workflowId, {
              workflowTemplate: true
            }),
            vote: this.getLatestVoteByWorkflowAndEntity(request, workflowId, request.requestor),
            entityMemberships: this.getEntityMemberships(request, request.requestor)
          })
        ),
        TE.chainW(({scope}) => {
          const {workflowWithTemplate, vote, entityMemberships} = scope
          const status = this.getVoteStatus(vote)
          const entityRoles = getEntityRoles(request.requestor)
          const canVoteResult = canVoteOnWorkflow(workflowWithTemplate, entityMemberships, entityRoles)

          return pipe(
            canVoteResult,
            E.fold(
              reason =>
                reason === "inconsistent_memberships"
                  ? TE.left<CanVoteError, CanVoteResponse>(reason)
                  : TE.right({canVote: false, reason, status}),
              ({requireHighPrivilege}) => TE.right({canVote: true, requireHighPrivilege, status})
            )
          )
        })
      )
    )
  }

  private getVoteStatus(vote: Option<Vote>): VoteStatus {
    if (isNone(vote) || vote.value.type === "WITHDRAW") return VoteStatus.VOTE_PENDING
    return VoteStatus.ALREADY_VOTED
  }

  private getLatestVoteByWorkflowAndEntity(
    context: TenantContext,
    workflowId: string,
    entity: AuthenticatedEntity
  ): TaskEither<GetLatestVoteError, Option<Vote>> {
    const voter = createEntityReference(entity)
    return this.voteRepo.getOptionalLatestVoteByWorkflowAndVoter(context, workflowId, voter)
  }

  private getEntityMemberships(
    context: RequestorAwareRequest,
    entity: AuthenticatedEntity
  ): TaskEither<GetLatestVoteError | CanVoteError, ReadonlyArray<MembershipWithGroupRef>> {
    const entityRef = createEntityReference(entity)
    switch (entity.entityType) {
      case "user":
        return this.groupMembershipRepo.getUserMembershipsByUserId(context, entityRef.entityId)
      case "agent":
        return this.groupMembershipRepo.getAgentMembershipsByAgentId(context, entityRef.entityId)
    }
  }

  /**
   * Casts a vote on a workflow.
   * Checks the authenticated requestor against current workflow eligibility inside a tenant transaction.
   * Persists the vote, recalculation marker, and durable outbox event atomically.
   * The outbox relay dispatches the recalculation asynchronously.
   * @param request The request containing vote data, workflowId, and the requestor.
   * @returns A TaskEither with the persisted vote or an error.
   */
  castVote(input: CastVoteRequest): TaskEither<CastVoteServiceError, Vote> {
    // Voting is optimistic: eligibility can change between the canVote check and persistence,
    // and the vote may still be registered. The check rejects votes that are already ineligible;
    // the transaction does not serialize concurrent changes to memberships or roles.
    // Workflow recalculation evaluates the recorded votes against approval rules without
    // rechecking each voter's current eligibility.
    return pipe(
      TE.right(input),
      inTransaction(this.transactionManager, input, (request: CastVoteRequest) =>
        pipe(
          this.requireVoteEligibility(request),
          TE.chainFirstW(() => this.checkVoteQuota(request)),
          TE.chainW(eligibility => this.verifyVotePrivilege(request, eligibility.requireHighPrivilege)),
          TE.chainW(() => this.persistVoteWithRecalculationEvent(request))
        )
      ),
      bestEffort(
        ({event}: {event: TenantEvent}) => this.publishRecalculation(input, event),
        (error, {event}) => Logger.warn(`Best-effort delivery failed for ${event.type} event ${event.eventId}`, error)
      ),
      TE.map(({vote}) => vote),
      logSuccess("Vote cast", "VoteService", vote => ({id: vote.id, workflowId: vote.workflowId}))
    )
  }

  private requireVoteEligibility(
    request: CastVoteRequest
  ): TaskEither<CanVoteError | CantVoteReason, Extract<CanVoteResponse, {canVote: true}>> {
    return pipe(
      this.canVote(request),
      TE.chainW(eligibility => {
        if (eligibility.canVote) return TE.right(eligibility)

        const entityRef = createEntityReference(request.requestor)
        Logger.error(
          `${entityRef.entityType} ${entityRef.entityId} cannot vote for workflow ${request.workflowId}: ${eligibility.reason}`
        )
        return TE.left(eligibility.reason)
      })
    )
  }

  private checkVoteQuota(request: CastVoteRequest): TaskEither<"quota_check_error" | "quota_exceeded", void> {
    return pipe(
      this.quotaService.isQuotaAvailable(
        {type: "Workflow", identifier: request.workflowId},
        "MAX_VOTES_PER_WORKFLOW",
        request,
        1
      ),
      TE.mapLeft(() => "quota_check_error" as const),
      TE.chainW(isAvailable => (isAvailable ? TE.right(undefined) : TE.left("quota_exceeded" as const)))
    )
  }

  private verifyVotePrivilege(
    request: CastVoteRequest,
    requireHighPrivilege: boolean
  ): TaskEither<WorkflowGetError | UseHighPrivilegeTokenError, void> {
    if (request.type !== "APPROVE")
      return requireHighPrivilege
        ? this.authService.useHighPrivilegeToken(request.requestor, "vote", request.workflowId)
        : TE.right(undefined)

    return pipe(
      this.workflowService.getWorkflowByIdentifier(request, request.workflowId, {workflowTemplate: true}),
      TE.chainW(workflowWithTemplate =>
        workflowWithTemplate.workflowTemplate.approvalRule.isHighPrivilegeRequired(request.votedForGroups)
          ? this.authService.useHighPrivilegeToken(request.requestor, "vote", request.workflowId)
          : TE.right(undefined)
      )
    )
  }

  private persistVoteWithRecalculationEvent(
    request: CastVoteRequest
  ): TaskEither<CastVoteServiceError, {readonly vote: Vote; readonly event: TenantEvent}> {
    return pipe(
      VoteFactory.newVote({...request, voter: createEntityReference(request.requestor)}),
      TE.fromEither,
      TE.bindTo("vote"),
      TE.let("event", ({vote}): TenantEvent => ({
        schemaVersion: 1,
        eventId: generateDeterministicId(`recalculate-${vote.workflowId}-${vote.id}`),
        workflowId: vote.workflowId,
        organizationId: request.organizationId,
        type: "workflow.recalculate"
      })),
      TE.chainFirstW(({vote}) => this.voteRepo.persistVoteAndMarkWorkflowRecalculation(request, vote)),
      TE.chainFirstW(({event}) => this.outboxRepository.append(request, event))
    )
  }

  private publishRecalculation(context: TenantContext, event: TenantEvent) {
    return pipe(
      this.queueService.enqueue(event),
      TE.chainW(() => this.outboxRepository.markPublished(context, event.eventId))
    )
  }

  /**
   * Lists all votes for a given workflow.
   * @param workflowId The ID of the workflow.
   * @returns A TaskEither with a list of votes or an error.
   */
  listVotes(
    context: TenantContext,
    workflowId: string
  ): TaskEither<FindVotesError | WorkflowGetError, ReadonlyArray<Vote>> {
    return pipe(
      TE.right(context),
      inTransaction(this.transactionManager, context, () =>
        pipe(
          this.workflowService.getWorkflowByIdentifier(context, workflowId),
          TE.chainW(() => this.voteRepo.getVotesByWorkflowId(context, workflowId))
        )
      ),
      logSuccess("Votes listed", "VoteService", votes => ({count: votes.length}))
    )
  }
}

export interface CanVoteRequest extends RequestorAwareRequest {
  workflowId: string
}

export enum VoteStatus {
  ALREADY_VOTED = "ALREADY_VOTED",
  VOTE_PENDING = "VOTE_PENDING"
}

export type CanVoteResponse = {status: VoteStatus} & (
  {canVote: true; requireHighPrivilege: boolean} | {canVote: false; reason: CantVoteReason}
)

export type CanVoteError =
  | "concurrency_error"
  | WorkflowGetError
  | "inconsistent_memberships"
  | MembershipValidationErrorWithGroupRef
  | UserValidationError
  | AgentValidationError
  | AgentKeyDecodeError
  | GetLatestVoteError
  | UnknownError
  | AuthorizationError
  | ExecutionError

export type CastVoteRequest = RequestorAwareRequest & DistributiveOmit<Vote, "id" | "castedAt" | "voter">

export type CastVoteServiceError =
  | TenantOperationError
  | "workflow_not_found"
  | "user_not_found"
  | CantVoteReason
  | PersistVoteError
  | CanVoteError
  | UnknownError
  | WorkflowUpdateError
  | AuthorizationError
  | UseHighPrivilegeTokenError
  | ExecutionError
  | "event_mismatch"
