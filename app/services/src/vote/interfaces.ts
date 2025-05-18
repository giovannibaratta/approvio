import {Vote, VoteValidationError} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {UnknownError} from "@services/error"
import {Option} from "fp-ts/lib/Option"

export const VOTE_REPOSITORY_TOKEN = "VoteRepositoryToken"

export type PersistVoteError = VoteValidationError | UnknownError | "workflow_not_found" | "user_not_found"
export type FindVotesError = UnknownError
export type GetLatestVoteError = UnknownError | VoteValidationError

export interface VoteRepository {
  persistVote(vote: Vote): TaskEither<PersistVoteError, Vote>
  getOptionalLatestVoteByWorkflowAndUser(
    workflowId: string,
    userId: string
  ): TaskEither<GetLatestVoteError, Option<Vote>>
}
