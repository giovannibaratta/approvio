import {Vote, VoteFactory, VoteValidationError} from "@domain"
import {Injectable, Logger} from "@nestjs/common"
import {Vote as PrismaVote} from "@prisma/client"
import {GetLatestVoteError, PersistVoteError, VoteRepository} from "@services/vote"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {none, Option, some} from "fp-ts/lib/Option"
import {pipe} from "fp-ts/lib/function"
import {DatabaseClient} from "./database-client"
import {isPrismaForeignKeyConstraintError} from "./errors"

@Injectable()
export class VoteDbRepository implements VoteRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  persistVote(vote: Vote): TaskEither<PersistVoteError, Vote> {
    return pipe(
      TE.tryCatchK(
        () =>
          this.dbClient.vote.create({
            data: {
              id: vote.id,
              workflowId: vote.workflowId,
              userId: vote.userId,
              voteType: vote.voteType,
              reason: vote.reason,
              voteMode: vote.voteMode,
              createdAt: vote.createdAt
            }
          }),
        error => {
          if (isPrismaForeignKeyConstraintError(error, "fk_votes_workflow")) return "workflow_not_found"
          if (isPrismaForeignKeyConstraintError(error, "fk_votes_user")) return "user_not_found"
          Logger.error(`Error saving vote for workflow ${vote.workflowId} and user ${vote.userId}`, error)
          return "unknown_error"
        }
      )(),
      TE.chainEitherKW(mapPrismaVoteToDomainVote)
    )
  }

  getOptionalLatestVoteByWorkflowAndUser(
    workflowId: string,
    userId: string
  ): TaskEither<GetLatestVoteError, Option<Vote>> {
    return pipe(
      TE.tryCatchK(
        () =>
          this.dbClient.vote.findFirst({
            where: {
              workflowId: workflowId,
              userId: userId
            },
            orderBy: {
              createdAt: "desc"
            }
          }),
        error => {
          Logger.error(`Error finding latest vote for workflow ${workflowId} and user ${userId}`, error)
          return "unknown_error" as const
        }
      )(),
      TE.chainEitherKW(mapOptionalToDomainVote)
    )
  }
}

function mapPrismaVoteToDomainVote(prismaVote: PrismaVote): E.Either<VoteValidationError, Vote> {
  const domainData = {
    id: prismaVote.id,
    workflowId: prismaVote.workflowId,
    userId: prismaVote.userId,
    voteType: prismaVote.voteType,
    reason: prismaVote.reason ?? undefined,
    voteMode: prismaVote.voteMode,
    createdAt: prismaVote.createdAt
  }
  return VoteFactory.validate(domainData)
}

function mapOptionalToDomainVote(prismaVote: PrismaVote | null): E.Either<VoteValidationError, Option<Vote>> {
  if (!prismaVote) return E.right(none)

  return pipe(prismaVote, mapPrismaVoteToDomainVote, E.map(some))
}
