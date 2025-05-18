import {MembershipValidationErrorWithGroupRef, Vote, VoteFactory, VoteType} from "@domain"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {UnknownError} from "@services/error"
import {RequestorAwareRequest} from "@services/shared/types"
import {WORKFLOW_REPOSITORY_TOKEN, WorkflowGetError, WorkflowRepository, WorkflowService} from "@services/workflow"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {GetLatestVoteError, PersistVoteError, VOTE_REPOSITORY_TOKEN, VoteRepository} from "./interfaces"
import {sequenceS} from "fp-ts/lib/Apply"
import {GROUP_MEMBERSHIP_REPOSITORY_TOKEN, GroupMembershipRepository} from "@services/group-membership"
import {isNone} from "fp-ts/lib/Option"

@Injectable()
export class VoteService {
  constructor(
    @Inject(VOTE_REPOSITORY_TOKEN)
    private readonly voteRepo: VoteRepository,
    @Inject(WORKFLOW_REPOSITORY_TOKEN)
    private readonly workflowRepo: WorkflowRepository,
    @Inject(GROUP_MEMBERSHIP_REPOSITORY_TOKEN)
    private readonly groupMembershipRepo: GroupMembershipRepository,
    private readonly workflowService: WorkflowService
  ) {}

  canVote(request: CanVoteRequest): TaskEither<CanVoteError, CanVoteResponse> {
    return pipe(
      sequenceS(TE.ApplicativePar)({
        workflow: this.workflowRepo.getWorkflowById(request.workflowId),
        vote: this.voteRepo.getOptionalLatestVoteByWorkflowAndUser(request.workflowId, request.requestor.id),
        userMemberships: this.groupMembershipRepo.getUserMembershipsByUserId(request.requestor.id)
      }),
      TE.map(scope => {
        const {workflow, vote, userMemberships} = scope

        const status =
          isNone(vote) || vote.value.voteType === VoteType.WITHDRAW ? VoteStatus.VOTE_PENDING : VoteStatus.ALREADY_VOTED

        const canVote = workflow.canVote(userMemberships)

        return {
          canVote,
          status
        }
      })
    )
  }

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
          request,
          E.right,
          E.chainW(request => VoteFactory.newVote({...request, userId: request.requestor.id})),
          TE.fromEither,
          TE.chainW(vote => this.voteRepo.persistVote(vote))
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
  VOTE_PENDING = "VOTE_PENDING"
}

export interface CanVoteResponse {
  canVote: boolean
  status: VoteStatus
}

export type CanVoteError = WorkflowGetError | MembershipValidationErrorWithGroupRef | GetLatestVoteError | UnknownError

export interface CastVoteRequest extends RequestorAwareRequest {
  workflowId: string
  voteType: string
  voteMode: string
  reason?: string
}

export type CastVoteServiceError =
  | "workflow_not_found"
  | "user_not_found"
  | "user_not_eligible_to_vote"
  | PersistVoteError
  | CanVoteError
  | UnknownError
