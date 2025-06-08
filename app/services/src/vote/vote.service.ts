import {MembershipValidationErrorWithGroupRef, Vote, VoteFactory, Workflow, WorkflowStatus} from "@domain"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {UnknownError} from "@services/error"
import {RequestorAwareRequest} from "@services/shared/types"
import {WORKFLOW_REPOSITORY_TOKEN, WorkflowGetError, WorkflowRepository, WorkflowUpdateError} from "@services/workflow"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {PersistVoteError, GetLatestVoteError, VOTE_REPOSITORY_TOKEN, VoteRepository} from "./interfaces"
import {sequenceS} from "fp-ts/lib/Apply"
import {GROUP_MEMBERSHIP_REPOSITORY_TOKEN, GroupMembershipRepository} from "@services/group-membership"
import {isNone, Option} from "fp-ts/lib/Option"
import {DistributiveOmit} from "@utils"

@Injectable()
export class VoteService {
  constructor(
    @Inject(VOTE_REPOSITORY_TOKEN)
    private readonly voteRepo: VoteRepository,
    @Inject(WORKFLOW_REPOSITORY_TOKEN)
    private readonly workflowRepo: WorkflowRepository,
    @Inject(GROUP_MEMBERSHIP_REPOSITORY_TOKEN)
    private readonly groupMembershipRepo: GroupMembershipRepository
  ) {}

  /**
   * Checks if a user is eligible to vote on a workflow and their current voting status.
   * @param request The request containing the workflowId and the requestor.
   * @returns A TaskEither with the user's eligibility and status, or an error.
   */
  canVote(request: CanVoteRequest): TaskEither<CanVoteError, CanVoteResponse> {
    return pipe(
      sequenceS(TE.ApplicativePar)({
        workflow: this.workflowRepo.getWorkflowById(request.workflowId),
        vote: this.voteRepo.getOptionalLatestVoteByWorkflowAndUser(request.workflowId, request.requestor.id),
        userMemberships: this.groupMembershipRepo.getUserMembershipsByUserId(request.requestor.id)
      }),
      TE.map(scope => {
        const {workflow, vote, userMemberships} = scope
        const status = this.getVoteStatus(workflow, vote)
        const canVote = workflow.canVote(userMemberships)

        return {canVote, status}
      })
    )
  }

  private getVoteStatus(workflow: Workflow, vote: Option<Vote>): VoteStatus {
    if (workflow.status === WorkflowStatus.CANCELED) return VoteStatus.VOTE_CANCELLED
    if (isNone(vote) || vote.value.type === "WITHDRAW") return VoteStatus.VOTE_PENDING
    return VoteStatus.ALREADY_VOTED
  }

  /**
   * Casts a vote on a workflow.
   * This action is optimistic and may be subject to race conditions.
   * The vote's validity is ultimately determined during the next workflow status evaluation.
   * @param request The request containing vote data, workflowId, and the requestor.
   * @returns A TaskEither with the persisted vote or an error.
   */
  castVote(request: CastVoteRequest): TaskEither<CastVoteServiceError, Vote> {
    // This implementation is based on an optimistic approach
    // If there's a race condition (e.g., user eligibility changes between canVote check and the persist action),
    // the vote is registered anyway. Conformity evaluation happens elsewhere.

    // We still perform a canVote check here to prevent obviously invalid votes,
    // but we are aware this check itself is subject to race conditions.
    return pipe(
      TE.Do,
      TE.bind("canVoteCheck", () => this.canVote({workflowId: request.workflowId, requestor: request.requestor})),
      TE.chainW(({canVoteCheck}) => {
        if (!canVoteCheck.canVote) {
          Logger.error(`User ${request.requestor.id} is not eligible to vote for workflow ${request.workflowId}`)
          return TE.left("user_not_eligible_to_vote" as const)
        }
        return pipe(
          VoteFactory.newVote({...request, userId: request.requestor.id}),
          TE.fromEither,
          TE.chainW(vote => this.voteRepo.persistVoteAndMarkWorkflowRecalculation(vote))
        )
      })
    )
  }
}

export interface CanVoteRequest extends RequestorAwareRequest {
  workflowId: string
}

export enum VoteStatus {
  ALREADY_VOTED = "ALREADY_VOTED",
  VOTE_PENDING = "VOTE_PENDING",
  VOTE_CANCELLED = "VOTE_CANCELLED"
}

export interface CanVoteResponse {
  canVote: boolean
  status: VoteStatus
}

export type CanVoteError = WorkflowGetError | MembershipValidationErrorWithGroupRef | GetLatestVoteError | UnknownError

export type CastVoteRequest = RequestorAwareRequest & DistributiveOmit<Vote, "id" | "castedAt" | "userId">

export type CastVoteServiceError =
  | "workflow_not_found"
  | "user_not_found"
  | "user_not_eligible_to_vote"
  | PersistVoteError
  | CanVoteError
  | UnknownError
  | WorkflowUpdateError
