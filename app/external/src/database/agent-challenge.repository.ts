import {
  AgentChallenge,
  AgentChallengeDecoratedValidationError,
  AgentChallengeFactory,
  DecoratedAgentChallenge
} from "@domain"
import {Injectable} from "@nestjs/common"
import {Prisma, AgentChallenge as PrismaAgentChallenge, Agent as PrismaAgent} from "@prisma/client"
import {
  AgentChallengeRepository,
  AgentChallengeCreateError,
  AgentChallengeGetError,
  AgentChallengeUpdateError,
  GetChallengeByNonceError
} from "@services"
import * as TE from "fp-ts/lib/TaskEither"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {DatabaseClient} from "./database-client"
import * as E from "fp-ts/lib/Either"
import {chainNullableToLeft} from "./utils"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"

type PrismaAgentChallengeWithAgent = PrismaAgentChallenge & {agents: PrismaAgent}

@Injectable()
export class AgentChallengeDbRepository implements AgentChallengeRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  persistChallenge(challenge: AgentChallenge): TaskEither<AgentChallengeCreateError, AgentChallenge> {
    return pipe(
      challenge,
      TE.right,
      TE.chainW(this.persistChallengeTask()),
      TE.chainEitherKW(this.mapPrismaChallengeToDomainForCreate)
    )
  }

  getChallengeByNonce(nonce: string): TaskEither<GetChallengeByNonceError, DecoratedAgentChallenge<{occ: true}>> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.agentChallenge.findUnique({
            where: {nonce},
            include: {agents: true}
          }),
        this.mapGetError
      ),
      chainNullableToLeft("agent_challenge_not_found" as const),
      TE.chainEitherKW(challengeWithAgent => this.mapPrismaChallengeWithAgentToDecoratedDomain(challengeWithAgent))
    )
  }

  updateChallenge(challenge: DecoratedAgentChallenge<{occ: true}>): TaskEither<AgentChallengeUpdateError, void> {
    return TE.tryCatch(
      async () => {
        const result = await this.dbClient.agentChallenge.updateMany({
          where: {
            id: challenge.id,
            occ: challenge.occ
          },
          data: {
            usedAt: challenge.usedAt || null,
            nonce: challenge.nonce,
            expiresAt: challenge.expiresAt,
            createdAt: challenge.createdAt,
            occ: {
              increment: 1
            }
          }
        })

        if (result.count === 0) {
          throw new Error("agent_challenge_concurrent_update")
        }
      },
      (error: unknown) => {
        return this.mapUpdateError(error)
      }
    )
  }

  private persistChallengeTask() {
    return (challenge: AgentChallenge): TaskEither<AgentChallengeCreateError, PrismaAgentChallengeWithAgent> =>
      TE.tryCatch(
        () =>
          this.dbClient.agentChallenge.create({
            data: this.mapDomainChallengeToPrisma(challenge),
            include: {
              agents: true
            }
          }),
        this.mapCreateError
      )
  }

  private mapDomainChallengeToPrisma(challenge: AgentChallenge): Prisma.AgentChallengeCreateInput {
    return {
      id: challenge.id,
      agents: {
        connect: {
          agentName: challenge.agentName
        }
      },
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      usedAt: challenge.usedAt || null,
      createdAt: challenge.createdAt,
      occ: POSTGRES_BIGINT_LOWER_BOUND
    }
  }

  private mapPrismaChallengeToDomainForCreate(
    prismaChallenge: PrismaAgentChallengeWithAgent
  ): E.Either<AgentChallengeCreateError, AgentChallenge> {
    const challenge: AgentChallenge = {
      id: prismaChallenge.id,
      agentName: prismaChallenge.agents.agentName,
      nonce: prismaChallenge.nonce,
      expiresAt: prismaChallenge.expiresAt,
      usedAt: prismaChallenge.usedAt || undefined,
      createdAt: prismaChallenge.createdAt
    }

    return E.right(challenge)
  }

  private mapPrismaChallengeWithAgentToDecoratedDomain(
    challengeWithAgent: PrismaAgentChallengeWithAgent
  ): E.Either<AgentChallengeDecoratedValidationError, DecoratedAgentChallenge<{occ: true}>> {
    const challenge: DecoratedAgentChallenge<{occ: true}> = {
      id: challengeWithAgent.id,
      agentName: challengeWithAgent.agents.agentName,
      nonce: challengeWithAgent.nonce,
      expiresAt: challengeWithAgent.expiresAt,
      usedAt: challengeWithAgent.usedAt || undefined,
      createdAt: challengeWithAgent.createdAt,
      occ: challengeWithAgent.occ
    }

    return pipe(
      E.right(challenge),
      E.chainW(data => AgentChallengeFactory.validate(data, {occ: true}))
    )
  }

  private mapCreateError = (): AgentChallengeCreateError => {
    return "agent_challenge_storage_error"
  }

  private mapGetError = (): AgentChallengeGetError => {
    return "unknown_error"
  }

  private mapUpdateError = (error: unknown): AgentChallengeUpdateError => {
    if (error instanceof Error && error.message === "agent_challenge_concurrent_update")
      return "agent_challenge_concurrent_update"
    return "unknown_error"
  }
}
