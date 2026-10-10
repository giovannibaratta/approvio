import {Injectable, Logger} from "@nestjs/common"
import {AgentChallenge, AgentChallengeFactory, DecoratedAgentChallenge, TenantContext} from "@domain"
import {
  AgentChallengeCreateError,
  AgentChallengeRepository,
  AgentChallengeUpdateError,
  GetChallengeByNonceError
} from "@services"
import {AgentChallenge as PrismaAgentChallenge, Prisma} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {AgentChallengeTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import {chainNullableToLeft} from "./utils"

@Injectable()
export class AgentChallengeDbRepository implements AgentChallengeRepository {
  constructor(private readonly dbClient: AgentChallengeTenantClient) {}

  persistChallenge(
    context: TenantContext,
    challenge: AgentChallenge
  ): TE.TaskEither<AgentChallengeCreateError, AgentChallenge> {
    return pipe(
      TE.tryCatch(
        async () => {
          if (context.organizationId !== challenge.organizationId) throw new ChallengeNotFoundError()
          return this.dbClient.cx.agentChallenge.create({
            data: {
              id: challenge.id,
              organizationId: context.organizationId,
              agentId: challenge.agentId,
              nonce: challenge.nonce,
              expiresAt: challenge.expiresAt,
              usedAt: challenge.usedAt ?? null,
              createdAt: challenge.createdAt,
              occ: 0n
            }
          })
        },
        error => this.mapCreateError(error)
      ),
      TE.chainEitherKW(record => E.mapLeft(() => "agent_challenge_storage_error" as const)(mapChallenge(record)))
    )
  }

  getChallengeByNonce(
    context: TenantContext,
    nonce: string
  ): TE.TaskEither<GetChallengeByNonceError, DecoratedAgentChallenge<{occ: true}>> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.cx.agentChallenge.findUnique({
            where: {organizationId_nonce: {organizationId: context.organizationId, nonce}}
          }),
        error => this.mapGetError(error)
      ),
      chainNullableToLeft("agent_challenge_not_found" as const),
      TE.chainEitherKW(mapChallenge)
    )
  }

  updateChallenge(
    context: TenantContext,
    challenge: DecoratedAgentChallenge<{occ: true}>
  ): TE.TaskEither<AgentChallengeUpdateError, void> {
    return TE.tryCatch(
      async () => {
        if (context.organizationId !== challenge.organizationId) throw new ChallengeConflictError()
        await this.dbClient.cx.agentChallenge.update({
          where: {id: challenge.id, organizationId: context.organizationId, occ: challenge.occ},
          data: {usedAt: challenge.usedAt ?? null, occ: {increment: 1}}
        })
      },
      error => this.mapUpdateError(error)
    )
  }

  private mapCreateError(error: unknown): AgentChallengeCreateError {
    if (isPrismaUniqueConstraintError(error, ["organization_id", "nonce"])) return "agent_challenge_storage_error"
    Logger.error("Agent challenge repository persist failed", error instanceof Error ? error.name : "non_error")
    return "agent_challenge_storage_error"
  }

  private mapGetError(error: unknown): GetChallengeByNonceError {
    Logger.error("Agent challenge repository lookup failed", error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }

  private mapUpdateError(error: unknown): AgentChallengeUpdateError {
    if (error instanceof ChallengeConflictError) return "agent_challenge_concurrent_update"
    if (isPrismaRecordNotFoundError(error, Prisma.ModelName.AgentChallenge)) return "agent_challenge_concurrent_update"
    Logger.error("Agent challenge repository update failed", error instanceof Error ? error.name : "non_error")
    return "agent_challenge_update_failed"
  }
}

function mapChallenge(
  record: PrismaAgentChallenge
): E.Either<GetChallengeByNonceError, DecoratedAgentChallenge<{occ: true}>> {
  return E.mapLeft(() => "unknown_error" as const)(
    AgentChallengeFactory.validate(
      {
        id: record.id,
        organizationId: record.organizationId,
        agentId: record.agentId,
        nonce: record.nonce,
        expiresAt: record.expiresAt,
        usedAt: record.usedAt ?? undefined,
        createdAt: record.createdAt,
        occ: record.occ
      },
      {occ: true}
    )
  )
}

class ChallengeNotFoundError extends Error {}
class ChallengeConflictError extends Error {}
