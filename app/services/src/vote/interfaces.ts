import {Vote, VoteValidationError, EntityReference} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {UnknownError} from "@services/error"
import {Option} from "fp-ts/lib/Option"
import {WorkflowGetError} from "../workflow/interfaces"

export const VOTE_REPOSITORY_TOKEN = "VoteRepositoryToken"

export type PersistVoteError = VoteValidationError | UnknownError | "workflow_not_found" | "voter_not_found"
export type FindVotesError = VoteValidationError | UnknownError | WorkflowGetError
export type GetLatestVoteError = UnknownError | VoteValidationError

export interface VoteRepository {
  persistVoteAndMarkWorkflowRecalculation(vote: Vote): TaskEither<PersistVoteError, Vote>
  getOptionalLatestVoteByWorkflowAndVoter(
    workflowId: string,
    voter: EntityReference
  ): TaskEither<GetLatestVoteError, Option<Vote>>
  getVotesByWorkflowId(workflowId: string): TaskEither<FindVotesError, ReadonlyArray<Vote>>
}
