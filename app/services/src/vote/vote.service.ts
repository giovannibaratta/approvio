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
  createEntityReference,
  getEntityRoles
} from "@domain"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {UnknownError, AuthorizationError} from "@services/error"
import {RequestorAwareRequest} from "@services/shared/types"
import {AgentKeyDecodeError} from "@services/agent/interfaces"
import {WorkflowGetError, WorkflowUpdateError} from "../workflow/interfaces"
import {WorkflowService} from "../workflow/workflow.service"
import {QueueService} from "../queue/queue.service"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {PersistVoteError, GetLatestVoteError, VOTE_REPOSITORY_TOKEN, VoteRepository, FindVotesError} from "./interfaces"
import {sequenceS} from "fp-ts/lib/Apply"
import {GROUP_MEMBERSHIP_REPOSITORY_TOKEN, GroupMembershipRepository} from "@services/group-membership"
import {isNone, Option} from "fp-ts/lib/Option"
import {DistributiveOmit, logSuccess} from "@utils"
import {isRight} from "fp-ts/lib/Either"

@Injectable()
export class VoteService {
  constructor(
    @Inject(VOTE_REPOSITORY_TOKEN)
    private readonly voteRepo: VoteRepository,
    private readonly workflowService: WorkflowService,
    @Inject(GROUP_MEMBERSHIP_REPOSITORY_TOKEN)
    private readonly groupMembershipRepo: GroupMembershipRepository,
    private readonly queueService: QueueService
  ) {}

  /**
   * Checks if a user is eligible to vote on a workflow and their current voting status.
   * @param request The request containing the workflowId and the requestor.
   * @returns A TaskEither with the user's eligibility and status, or an error.
   */
  canVote(request: CanVoteRequest): TaskEither<CanVoteError, CanVoteResponse> {
    return pipe(
      TE.Do,
      TE.bindW("workflowId", () => TE.right(request.workflowId)),
      TE.bindW("scope", ({workflowId}) =>
        sequenceS(TE.ApplicativePar)({
          workflowWithTemplate: this.workflowService.getWorkflowByIdentifier(workflowId, {
            workflowTemplate: true
          }),
          vote: this.getLatestVoteByWorkflowAndEntity(workflowId, request.requestor),
          entityMemberships: this.getEntityMemberships(request.requestor)
        })
      ),
      TE.map(({scope}) => {
        const {workflowWithTemplate, vote, entityMemberships} = scope
        const status = this.getVoteStatus(vote)
        const entityRoles = getEntityRoles(request.requestor)
        const canVoteResult = canVoteOnWorkflow(workflowWithTemplate, entityMemberships, entityRoles)
        const canVote = isRight(canVoteResult) ? true : {reason: canVoteResult.left}

        return {canVote, status}
      })
    )
  }

  private getVoteStatus(vote: Option<Vote>): VoteStatus {
    if (isNone(vote) || vote.value.type === "WITHDRAW") return VoteStatus.VOTE_PENDING
    return VoteStatus.ALREADY_VOTED
  }

  private getLatestVoteByWorkflowAndEntity(
    workflowId: string,
    entity: AuthenticatedEntity
  ): TaskEither<GetLatestVoteError, Option<Vote>> {
    const voter = createEntityReference(entity)
    return this.voteRepo.getOptionalLatestVoteByWorkflowAndVoter(workflowId, voter)
  }

  private getEntityMemberships(
    entity: AuthenticatedEntity
  ): TaskEither<GetLatestVoteError | CanVoteError, ReadonlyArray<MembershipWithGroupRef>> {
    const entityRef = createEntityReference(entity)
    switch (entity.entityType) {
      case "user":
        return this.groupMembershipRepo.getUserMembershipsByUserId(entityRef.entityId)
      case "agent":
        return this.groupMembershipRepo.getAgentMembershipsByAgentId(entityRef.entityId)
    }
  }

  /**
   * Casts a vote on a workflow.
   * This action is optimistic and may be subject to race conditions.
   * The vote's validity is ultimately determined during the next workflow status evaluation.
   * After persisting the vote, enqueues a recalculation job in a best-effort manner.
   * @param request The request containing vote data, workflowId, and the requestor.
   * @returns A TaskEither with the persisted vote or an error.
   */
  castVote(request: CastVoteRequest): TaskEither<CastVoteServiceError, Vote> {
    // This implementation is based on an optimistic approach
    // If there's a race condition (e.g., entity eligibility changes between canVote check and the persist action),
    // the vote is registered anyway. Conformity evaluation happens elsewhere.

    // We still perform a canVote check here to prevent obviously invalid votes,
    // but we are aware this check itself is subject to race conditions.
    return pipe(
      TE.Do,
      TE.bind("canVoteCheck", () => this.canVote({workflowId: request.workflowId, requestor: request.requestor})),
      TE.chainW(({canVoteCheck}) => {
        if (canVoteCheck.canVote !== true) {
          const entityRef = createEntityReference(request.requestor)
          Logger.error(
            `${entityRef.entityType} ${entityRef.entityId} cannot vote for workflow ${request.workflowId}: ${canVoteCheck.canVote.reason}`
          )
          return TE.left(canVoteCheck.canVote.reason)
        }

        // Create vote with voter object
        const voter = createEntityReference(request.requestor)
        const voteData = {...request, voter}

        return pipe(
          VoteFactory.newVote(voteData),
          TE.fromEither,
          TE.chainW(vote => this.voteRepo.persistVoteAndMarkWorkflowRecalculation(vote)),
          TE.chainFirstW(this.enqueueRecalculationBestEffort),
          logSuccess("Vote cast", "VoteService", vote => ({id: vote.id, workflowId: vote.workflowId}))
        )
      })
    )
  }

  private enqueueRecalculationBestEffort = (vote: Vote): TaskEither<never, void> => {
    return pipe(
      this.queueService.enqueueWorkflowStatusRecalculation(vote.workflowId),
      TE.orElseW(() => {
        Logger.warn(`Failed to enqueue recalculation for workflow ${vote.workflowId}, vote persisted successfully`)
        return TE.right(undefined)
      })
    )
  }

  /**
   * Lists all votes for a given workflow.
   * @param workflowId The ID of the workflow.
   * @returns A TaskEither with a list of votes or an error.
   */
  listVotes(workflowId: string): TaskEither<FindVotesError | WorkflowGetError, ReadonlyArray<Vote>> {
    return pipe(
      this.workflowService.getWorkflowByIdentifier(workflowId),
      TE.chainW(() => this.voteRepo.getVotesByWorkflowId(workflowId)),
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

export interface CanVoteResponse {
  canVote: true | {reason: CantVoteReason}
  status: VoteStatus
}

export type CanVoteError =
  | "concurrency_error"
  | WorkflowGetError
  | MembershipValidationErrorWithGroupRef
  | UserValidationError
  | AgentValidationError
  | AgentKeyDecodeError
  | GetLatestVoteError
  | UnknownError
  | AuthorizationError

export type CastVoteRequest = RequestorAwareRequest & DistributiveOmit<Vote, "id" | "castedAt" | "voter">

export type CastVoteServiceError =
  | "workflow_not_found"
  | "user_not_found"
  | CantVoteReason
  | PersistVoteError
  | CanVoteError
  | UnknownError
  | WorkflowUpdateError
  | AuthorizationError
