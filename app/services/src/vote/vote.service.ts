import {
  MembershipValidationErrorWithGroupRef,
  Vote,
  VoteFactory,
  CantVoteReason,
  canVoteOnWorkflow,
  UserValidationError
} from "@domain"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {UnknownError} from "@services/error"
import {RequestorAwareRequest} from "@services/shared/types"
import {WorkflowGetError, WorkflowUpdateError} from "../workflow/interfaces"
import {WorkflowService} from "../workflow/workflow.service"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {PersistVoteError, GetLatestVoteError, VOTE_REPOSITORY_TOKEN, VoteRepository} from "./interfaces"
import {sequenceS} from "fp-ts/lib/Apply"
import {GROUP_MEMBERSHIP_REPOSITORY_TOKEN, GroupMembershipRepository} from "@services/group-membership"
import {isNone, Option} from "fp-ts/lib/Option"
import {DistributiveOmit} from "@utils"
import {isRight} from "fp-ts/lib/Either"

@Injectable()
export class VoteService {
  constructor(
    @Inject(VOTE_REPOSITORY_TOKEN)
    private readonly voteRepo: VoteRepository,
    private readonly workflowService: WorkflowService,
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
        workflowWithTemplate: this.workflowService.getWorkflowByIdentifier(request.workflowId, {
          workflowTemplate: true
        }),
        vote: this.voteRepo.getOptionalLatestVoteByWorkflowAndUser(request.workflowId, request.requestor.id),
        userMemberships: this.groupMembershipRepo.getUserMembershipsByUserId(request.requestor.id)
      }),
      TE.map(scope => {
        const {workflowWithTemplate, vote, userMemberships} = scope
        const status = this.getVoteStatus(vote)
        const entityRoles = request.requestor.roles
        const canVoteResult = canVoteOnWorkflow(workflowWithTemplate, userMemberships, entityRoles)
        const canVote = isRight(canVoteResult) ? true : {reason: canVoteResult.left}

        return {canVote, status}
      })
    )
  }

  private getVoteStatus(vote: Option<Vote>): VoteStatus {
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
        if (canVoteCheck.canVote !== true) {
          Logger.error(
            `User ${request.requestor.id} cannot vote for workflow ${request.workflowId}: ${canVoteCheck.canVote.reason}`
          )
          return TE.left(canVoteCheck.canVote.reason)
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
  | GetLatestVoteError
  | UnknownError

export type CastVoteRequest = RequestorAwareRequest & DistributiveOmit<Vote, "id" | "castedAt" | "userId">

export type CastVoteServiceError =
  | "workflow_not_found"
  | "user_not_found"
  | CantVoteReason
  | PersistVoteError
  | CanVoteError
  | UnknownError
  | WorkflowUpdateError
