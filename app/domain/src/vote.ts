export const VOTE_REASON_MAX_LENGTH = 1024
import {randomUUID} from "crypto"
import {Either, isLeft, left, right} from "fp-ts/Either"
import {getStringAsEnum, isUUIDv4} from "@utils"

export enum VoteType {
  APPROVE = "APPROVE",
  DECLINE = "DECLINE",
  WITHDRAW = "WITHDRAW"
}

export enum VoteModeType {
  VOTE_FOR_ALL = "VOTE_FOR_ALL"
}

export type Vote = Readonly<PrivateVote>

interface PrivateVote {
  id: string
  workflowId: string
  userId: string
  voteType: VoteType
  reason?: string
  voteMode: VoteModeType
  createdAt: Date
}

export type VoteValidationError =
  | "invalid_workflow_id"
  | "invalid_user_id"
  | "invalid_vote_type"
  | "invalid_vote_mode"
  | "reason_too_long"

export class VoteFactory {
  static newVote(data: {
    workflowId: string
    userId: string
    voteType: string
    voteMode: string
    reason?: string
  }): Either<VoteValidationError, Vote> {
    const id = randomUUID()
    const createdAt = new Date()

    const vote: Omit<Vote, "voteType" | "voteMode"> & {voteType: string; voteMode: string} = {
      ...data,
      id,
      createdAt
    }
    return VoteFactory.validate(vote)
  }

  static validate(
    data: Omit<Vote, "voteType" | "voteMode"> & {voteType: string; voteMode: string}
  ): Either<VoteValidationError, Vote> {
    const workflowIdValidation = validateUUID(data.workflowId, "invalid_workflow_id")
    const userIdValidation = validateUUID(data.userId, "invalid_user_id")
    const voteTypeValidation = validateVoteType(data.voteType)
    const voteModeValidation = validateVoteMode(data.voteMode)
    const reasonValidation = data.reason ? validateReason(data.reason) : right(undefined)

    if (isLeft(workflowIdValidation)) return workflowIdValidation
    if (isLeft(userIdValidation)) return userIdValidation
    if (isLeft(voteTypeValidation)) return voteTypeValidation
    if (isLeft(voteModeValidation)) return voteModeValidation
    if (isLeft(reasonValidation)) return reasonValidation

    return right({
      id: data.id,
      workflowId: workflowIdValidation.right,
      userId: userIdValidation.right,
      voteType: voteTypeValidation.right,
      reason: reasonValidation.right,
      voteMode: voteModeValidation.right,
      createdAt: data.createdAt
    })
  }
}

function validateUUID<T extends "invalid_workflow_id" | "invalid_user_id">(id: string, error: T): Either<T, string> {
  if (!isUUIDv4(id)) return left(error)
  return right(id)
}

function validateVoteType(voteType: string): Either<VoteValidationError, VoteType> {
  const enumVoteType = getStringAsEnum(voteType, VoteType)
  if (enumVoteType === undefined) return left("invalid_vote_type")
  return right(enumVoteType)
}

function validateVoteMode(voteMode: string): Either<VoteValidationError, VoteModeType> {
  const enumVoteMode = getStringAsEnum(voteMode, VoteModeType)
  if (enumVoteMode === undefined) return left("invalid_vote_mode")
  return right(enumVoteMode)
}

function validateReason(reason: string): Either<VoteValidationError, string> {
  if (reason.length > VOTE_REASON_MAX_LENGTH) return left("reason_too_long")
  return right(reason)
}
