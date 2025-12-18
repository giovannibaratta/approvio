import {Vote, VoteFactory, VoteValidationError, EntityReference, getNormalizedEntityId} from "@domain"
import {Injectable, Logger} from "@nestjs/common"
import {Vote as PrismaVote} from "@prisma/client"
import {PersistVoteError, GetLatestVoteError, VoteRepository, FindVotesError} from "@services"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {none, Option, some} from "fp-ts/lib/Option"
import {pipe} from "fp-ts/lib/function"
import {DatabaseClient} from "./database-client"
import {isPrismaForeignKeyConstraintError} from "./errors"
import {traverseArray} from "fp-ts/lib/Either"

@Injectable()
export class VoteDbRepository implements VoteRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  /**
   * Persists a vote and marks the corresponding workflow for status recalculation.
   * This is performed in a single transaction.
   * @param vote The domain Vote object to persist.
   * @returns A TaskEither with the persisted vote or a persistence error.
   */
  persistVoteAndMarkWorkflowRecalculation(vote: Vote): TaskEither<PersistVoteError, Vote> {
    return pipe(
      TE.tryCatchK(
        () =>
          this.dbClient.$transaction(async tx => {
            const savedVote = await tx.vote.create({
              data: {
                id: vote.id,
                workflowId: vote.workflowId,
                userId: vote.voter.entityType === "user" ? vote.voter.entityId : null,
                agentId: vote.voter.entityType === "agent" ? vote.voter.entityId : null,
                voteType: vote.type,
                reason: vote.reason,
                votedForGroups: vote.type === "APPROVE" ? [...vote.votedForGroups] : undefined,
                createdAt: vote.castedAt
              }
            })

            await tx.workflow.update({
              where: {id: vote.workflowId},
              data: {recalculationRequired: true, occ: {increment: 1}}
            })

            return savedVote
          }),
        error => {
          if (isPrismaForeignKeyConstraintError(error, "fk_votes_workflow")) return "workflow_not_found"
          if (isPrismaForeignKeyConstraintError(error, "fk_votes_user")) return "voter_not_found"
          if (isPrismaForeignKeyConstraintError(error, "fk_votes_agent")) return "voter_not_found"

          Logger.error(
            `Error saving vote for workflow ${vote.workflowId} and voter ${getNormalizedEntityId(vote.voter)}`,
            error
          )
          return "unknown_error"
        }
      )(),
      TE.chainEitherKW(mapPrismaVoteToDomainVote)
    )
  }

  /**
   * Gets the most recent vote for a given voter on a given workflow, if one exists.
   * @param workflowId The ID of the workflow.
   * @param voter Reference to identify the voter entity.
   * @returns A TaskEither with an Option of the vote or an error.
   */
  getOptionalLatestVoteByWorkflowAndVoter(
    workflowId: string,
    voter: EntityReference
  ): TaskEither<GetLatestVoteError, Option<Vote>> {
    const whereClause =
      voter.entityType === "user"
        ? {workflowId, userId: voter.entityId, agentId: null}
        : {workflowId, agentId: voter.entityId, userId: null}

    return pipe(
      TE.tryCatchK(
        () =>
          this.dbClient.vote.findFirst({
            where: whereClause,
            orderBy: {
              createdAt: "desc"
            }
          }),
        error => {
          Logger.error(
            `Error finding latest vote for workflow ${workflowId} and ${voter.entityType} ${voter.entityId}`,
            error
          )
          return "unknown_error" as const
        }
      )(),
      TE.chainEitherKW(mapOptionalToDomainVote)
    )
  }

  /**
   * Gets all votes associated with a workflow, ordered by creation date.
   * @param workflowId The ID of the workflow.
   * @returns A TaskEither with a readonly array of votes or an error.
   */
  getVotesByWorkflowId(workflowId: string): TaskEither<FindVotesError, ReadonlyArray<Vote>> {
    return pipe(
      TE.tryCatchK(
        () =>
          this.dbClient.vote.findMany({
            where: {
              workflowId
            },
            orderBy: {
              createdAt: "asc"
            }
          }),
        error => {
          Logger.error(`Error finding votes for workflow ${workflowId}`, error)
          return "unknown_error" as const
        }
      )(),
      TE.chainEitherKW(mapPrismaVotesToDomainVotes)
    )
  }
}

function mapPrismaVoteToDomainVote(prismaVote: PrismaVote): E.Either<VoteValidationError, Vote> {
  // Validate that exactly one of userId or agentId is set
  if (!prismaVote.userId && !prismaVote.agentId) return E.left("vote_missing_voter_entity")
  if (prismaVote.userId && prismaVote.agentId) return E.left("vote_conflicting_voter_entities")

  const voter: EntityReference = prismaVote.userId
    ? {entityId: prismaVote.userId, entityType: "user"}
    : {entityId: prismaVote.agentId!, entityType: "agent"}

  const domainData = {
    id: prismaVote.id,
    workflowId: prismaVote.workflowId,
    voter,
    reason: prismaVote.reason ?? undefined,
    castedAt: prismaVote.createdAt
  }

  if (prismaVote.voteType === "APPROVE") {
    if (!prismaVote.votedForGroups) return E.left("vote_voted_for_groups_required")

    return VoteFactory.validate({
      ...domainData,
      type: "APPROVE",
      votedForGroups: prismaVote.votedForGroups
    })
  }

  if (prismaVote.voteType === "VETO") {
    return VoteFactory.validate({
      ...domainData,
      type: "VETO"
    })
  }

  if (prismaVote.voteType === "WITHDRAW") {
    return VoteFactory.validate({
      ...domainData,
      type: "WITHDRAW"
    })
  }

  return E.left("vote_invalid_vote_type")
}

function mapPrismaVotesToDomainVotes(
  prismaVotes: ReadonlyArray<PrismaVote>
): E.Either<VoteValidationError, ReadonlyArray<Vote>> {
  return traverseArray(mapPrismaVoteToDomainVote)(prismaVotes)
}

function mapOptionalToDomainVote(prismaVote: PrismaVote | null): E.Either<VoteValidationError, Option<Vote>> {
  if (!prismaVote) return E.right(none)

  return pipe(prismaVote, mapPrismaVoteToDomainVote, E.map(some))
}
