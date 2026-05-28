export const VOTE_REASON_MAX_LENGTH = 1024

import {Either, isLeft, left, right} from "fp-ts/Either"
import {DistributiveOmit, isUUIDv7, PrefixUnion} from "@utils"
import {EntityReference} from "./authenticated-entity"
import {v7 as uuidv7} from "uuid"

export type Vote = Readonly<ApproveVote | VetoVote | WithdrawVote>

interface _BaseVote {
  id: string
  workflowId: string
  voter: EntityReference
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
  | "invalid_voter_id"
  | "invalid_voter_type"
  | "invalid_vote_type"
  | "reason_too_long"
  | "invalid_group_id"
  | "voted_for_groups_required"
  | "missing_voter_entity"
  | "conflicting_voter_entities"

export class VoteFactory {
  static newVote(data: DistributiveOmit<Vote, "id" | "castedAt">): Either<VoteValidationError, Vote> {
    const id = uuidv7()
    const castedAt = new Date()

    const baseVoteProperties = {
      id,
      workflowId: data.workflowId,
      voter: data.voter,
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
    const voterValidation = validateVoter(data.voter)
    const reasonValidation = data.reason ? validateReason(data.reason) : right(undefined)

    if (isLeft(workflowIdValidation)) return workflowIdValidation
    if (isLeft(voterValidation)) return voterValidation
    if (isLeft(reasonValidation)) return reasonValidation

    if (data.type === "APPROVE") {
      const votedForGroupsValidation = validateGroupIds(data.votedForGroups)
      if (isLeft(votedForGroupsValidation)) return votedForGroupsValidation
    }

    return right(data)
  }
}

function validateUUID<T extends VoteValidationError>(id: string, error: T): Either<T, string> {
  if (!isUUIDv7(id)) return left(error)
  return right(id)
}

function validateVoter(voter: EntityReference): Either<VoteValidationError, EntityReference> {
  const voterIdValidation = validateUUID(voter.entityId, "vote_invalid_voter_id")
  if (isLeft(voterIdValidation)) return voterIdValidation

  if (voter.entityType !== "user" && voter.entityType !== "agent") {
    return left("vote_invalid_voter_type")
  }

  return right(voter)
}

function validateGroupIds(groupIds: ReadonlyArray<string>): Either<VoteValidationError, ReadonlyArray<string>> {
  if (groupIds.some(id => !isUUIDv7(id))) return left("vote_invalid_group_id")
  return right(groupIds)
}

function validateReason(reason: string): Either<VoteValidationError, string> {
  if (reason.length > VOTE_REASON_MAX_LENGTH) return left("vote_reason_too_long")
  return right(reason)
}
