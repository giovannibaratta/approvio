import {
  AgentChallenge,
  AgentChallengeDecoratedValidationError,
  AgentChallengeFactory,
  DecoratedAgentChallenge,
  TenantContext
} from "@domain"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, AgentChallenge as PrismaAgentChallenge} from "@prisma/client"
import {
  AgentChallengeRepository,
  AgentChallengeCreateError,
  AgentChallengeUpdateError,
  GetChallengeByNonceError,
  UnknownError
} from "@services"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {AgentChallengeTenantClient} from "./tenant-database-clients"
import * as E from "fp-ts/Either"
import {chainNullableToLeft} from "./utils"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {fromPromise} from "./repository-operation"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"

@Injectable()
export class AgentChallengeDbRepository implements AgentChallengeRepository {
  constructor(private readonly dbClient: AgentChallengeTenantClient) {}

  persistChallenge(challenge: AgentChallenge): TaskEither<AgentChallengeCreateError, AgentChallenge> {
    return pipe(challenge, TE.right, TE.chainFirstW(this.persistChallengeTask()))
  }

  getChallengeByNonce(
    context: TenantContext,
    nonce: string
  ): TaskEither<GetChallengeByNonceError, DecoratedAgentChallenge<{occ: true}>> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.agentChallenge.findUnique({
            where: {organizationId_nonce: {organizationId: context.organizationId, nonce}}
          }),
        this.mapGetError
      ),
      chainNullableToLeft("agent_challenge_not_found" as const),
      TE.chainEitherKW(challenge => this.mapPrismaChallengeWithAgentToDecoratedDomain(challenge))
    )
  }

  updateChallenge(
    context: TenantContext,
    challenge: DecoratedAgentChallenge<{occ: true}>
  ): TaskEither<AgentChallengeUpdateError, void> {
    return fromPromise(async () => {
      await this.dbClient.cx.agentChallenge.update({
        where: {id: challenge.id, organizationId: context.organizationId, occ: challenge.occ},
        data: {
          usedAt: challenge.usedAt ?? null,
          nonce: challenge.nonce,
          expiresAt: challenge.expiresAt,
          createdAt: challenge.createdAt,
          occ: {increment: 1}
        }
      })
    }, this.mapUpdateError)
  }

  private persistChallengeTask() {
    return (challenge: AgentChallenge): TaskEither<AgentChallengeCreateError, PrismaAgentChallenge> =>
      fromPromise(
        () => this.dbClient.cx.agentChallenge.create({data: this.mapDomainChallengeToPrisma(challenge)}),
        this.mapCreateError
      )
  }

  private mapDomainChallengeToPrisma(challenge: AgentChallenge): Prisma.AgentChallengeCreateInput {
    return {
      id: challenge.id,
      organizations: {connect: {id: challenge.organizationId}},
      agents: {
        connect: {
          organizationId_id: {organizationId: challenge.organizationId, id: challenge.agentId}
        }
      },
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      usedAt: challenge.usedAt ?? null,
      createdAt: challenge.createdAt,
      occ: POSTGRES_BIGINT_LOWER_BOUND
    }
  }

  private mapPrismaChallengeWithAgentToDecoratedDomain(
    challenge: PrismaAgentChallenge
  ): E.Either<AgentChallengeDecoratedValidationError, DecoratedAgentChallenge<{occ: true}>> {
    return AgentChallengeFactory.validate(
      {
        id: challenge.id,
        organizationId: challenge.organizationId,
        agentId: challenge.agentId,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        usedAt: challenge.usedAt ?? undefined,
        createdAt: challenge.createdAt,
        occ: challenge.occ
      },
      {occ: true}
    )
  }

  private mapCreateError = (error: unknown): AgentChallengeCreateError => {
    if (isPrismaUniqueConstraintError(error, ["organization_id", "nonce"])) return "agent_challenge_storage_error"
    Logger.error("Agent challenge repository persist failed", error instanceof Error ? error.name : "non_error")
    return "agent_challenge_storage_error"
  }

  private mapGetError = (error: unknown): UnknownError => {
    Logger.error("Agent challenge repository lookup failed", error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }

  private mapUpdateError = (error: unknown): AgentChallengeUpdateError => {
    if (isPrismaRecordNotFoundError(error, Prisma.ModelName.AgentChallenge)) return "agent_challenge_concurrent_update"
    Logger.error("Agent challenge repository update failed", error instanceof Error ? error.name : "non_error")
    return "agent_challenge_update_failed"
  }
}
