export const VOTE_REASON_MAX_LENGTH = 1024
import {randomUUID} from "crypto"
import {Either, isLeft, left, right} from "fp-ts/Either"
import {DistributiveOmit, isUUIDv4, PrefixUnion} from "@utils"

export type Vote = Readonly<ApproveVote | VetoVote | WithdrawVote>

interface _BaseVote {
  id: string
  workflowId: string
  userId: string
  reason?: string
  castedAt: Date
}

export interface ApproveVote extends _BaseVote {
  readonly type: "APPROVE"
  votedForGroups: ReadonlyArray<string>
}

export interface VetoVote extends _BaseVote {
  readonly type: "VETO"
}

export interface WithdrawVote extends _BaseVote {
  readonly type: "WITHDRAW"
}

export type VoteValidationError = PrefixUnion<"vote", UnprefixedVoteValidationError>

type UnprefixedVoteValidationError =
  | "invalid_workflow_id"
  | "invalid_user_id"
  | "invalid_vote_type"
  | "reason_too_long"
  | "invalid_group_id"
  | "voted_for_groups_required"

export class VoteFactory {
  static newVote(data: DistributiveOmit<Vote, "id" | "castedAt">): Either<VoteValidationError, Vote> {
    const id = randomUUID()
    const castedAt = new Date()

    const baseVoteProperties = {
      id,
      workflowId: data.workflowId,
      userId: data.userId,
      reason: data.reason,
      castedAt
    }

    switch (data.type) {
      case "APPROVE":
        return VoteFactory.validate({
          ...baseVoteProperties,
          type: "APPROVE",
          votedForGroups: data.votedForGroups
        })
      case "VETO":
        return VoteFactory.validate({
          ...baseVoteProperties,
          type: "VETO"
        })
      case "WITHDRAW":
        return VoteFactory.validate({
          ...baseVoteProperties,
          type: "WITHDRAW"
        })
    }
  }

  static validate(data: Vote): Either<VoteValidationError, Vote> {
    const workflowIdValidation = validateUUID(data.workflowId, "vote_invalid_workflow_id")
    const userIdValidation = validateUUID(data.userId, "vote_invalid_user_id")

    const reasonValidation = data.reason ? validateReason(data.reason) : right(undefined)

    if (isLeft(workflowIdValidation)) return workflowIdValidation
    if (isLeft(userIdValidation)) return userIdValidation
    if (isLeft(reasonValidation)) return reasonValidation

    if (data.type === "APPROVE") {
      const votedForGroupsValidation = validateGroupIds(data.votedForGroups)
      if (isLeft(votedForGroupsValidation)) return votedForGroupsValidation
    }

    return right(data)
  }
}

function validateUUID<T extends VoteValidationError>(id: string, error: T): Either<T, string> {
  if (!isUUIDv4(id)) return left(error)
  return right(id)
}

function validateGroupIds(groupIds: ReadonlyArray<string>): Either<VoteValidationError, ReadonlyArray<string>> {
  if (groupIds.some(id => !isUUIDv4(id))) return left("vote_invalid_group_id")
  return right(groupIds)
}

function validateReason(reason: string): Either<VoteValidationError, string> {
  if (reason.length > VOTE_REASON_MAX_LENGTH) return left("vote_reason_too_long")
  return right(reason)
}

/**
 * Consolidates votes by removing outdated votes and keeping the most meaningful vote for each user.
 * @param votes - The votes to consolidate.
 * @returns The consolidated votes.
 */
export function consolidateVotes(votes: ReadonlyArray<Vote>): ReadonlyArray<Vote> {
  const votesSortedDesc = [...votes].sort((a, b) => b.castedAt.getTime() - a.castedAt.getTime())
  const processedUsers: Set<string> = new Set()
  const votesToKeep = []

  for (const vote of votesSortedDesc) {
    if (processedUsers.has(vote.userId)) continue

    processedUsers.add(vote.userId)

    if (vote.type === "APPROVE" || vote.type === "VETO") votesToKeep.push(vote)
  }

  return votesToKeep
}
