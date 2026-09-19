import {fromPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {
  AccountRefreshToken,
  AccountRefreshTokenFactory,
  AgentRefreshToken,
  AgentRefreshTokenFactory,
  RefreshTokenStatus,
  RefreshTokenValidationError,
  TenantContext,
  UsedAccountRefreshToken,
  UsedAgentRefreshToken,
  DecoratedAccountRefreshToken,
  DecoratedActiveAccountRefreshToken,
  DecoratedActiveAgentRefreshToken,
  DecoratedAgentRefreshToken
} from "@domain"
import {
  AccountRefreshTokenRepository,
  AgentRefreshTokenRepository,
  RefreshTokenCreateError,
  RefreshTokenGetError,
  RefreshTokenUpdateError
} from "@services/auth"
import {
  RefreshToken as PrismaAccountRefreshToken,
  AgentRefreshToken as PrismaAgentRefreshToken,
  Prisma
} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {SessionDatabaseClient} from "./capability-database-client"
import {AgentRefreshTokenTenantClient} from "./tenant-database-clients"
import {chainNullableToLeft} from "./utils"
import {isPrismaRecordNotFoundError} from "./errors"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"

@Injectable()
export class AccountRefreshTokenDbRepository implements AccountRefreshTokenRepository {
  constructor(private readonly sessions: SessionDatabaseClient) {}

  createToken(token: AccountRefreshToken): TE.TaskEither<RefreshTokenCreateError, AccountRefreshToken> {
    return pipe(
      fromPromise(
        () => this.sessions.transactional(tx => tx.refreshToken.create({data: accountData(token)})),
        error => mapCreateError(error, "account refresh create")
      ),
      TE.chainEitherKW(mapAccountToken)
    )
  }

  getByTokenHash(tokenHash: string): TE.TaskEither<RefreshTokenGetError, DecoratedAccountRefreshToken<{occ: true}>> {
    return pipe(
      fromPromise(
        () => this.sessions.transactional(tx => tx.refreshToken.findUnique({where: {tokenHash}})),
        error => mapGetError(error, "account refresh lookup")
      ),
      chainNullableToLeft("refresh_token_not_found" as const),
      TE.chainEitherKW(mapAccountToken)
    )
  }

  persistNewTokenUpdateOld(
    newToken: DecoratedActiveAccountRefreshToken<{occ: true}>,
    oldToken: UsedAccountRefreshToken,
    expectedOcc: bigint
  ): TE.TaskEither<RefreshTokenUpdateError, void> {
    return fromPromise(
      async () => {
        return this.sessions.transactional(async tx => {
          // The used token references its successor. Insert that successor before
          // updating nextTokenId so the self-referential FK remains valid.
          await tx.refreshToken.create({data: accountData(newToken)})

          await tx.refreshToken.update({
            where: {id: oldToken.id, occ: expectedOcc},
            data: {
              status: oldToken.status,
              usedAt: oldToken.usedAt,
              nextTokenId: oldToken.nextTokenId,
              occ: {increment: 1}
            }
          })
        })
      },
      error => mapRotationError(error, Prisma.ModelName.RefreshToken, "account refresh rotate")
    )
  }

  revokeFamily(familyId: string): TE.TaskEither<RefreshTokenUpdateError, void> {
    return fromPromise(
      () =>
        this.sessions.transactional(tx =>
          tx.refreshToken
            .updateMany({where: {familyId}, data: {status: RefreshTokenStatus.REVOKED, occ: {increment: 1}}})
            .then(() => undefined)
        ),
      error => mapUpdateError(error, "account refresh revoke family")
    )
  }
}

@Injectable()
export class AgentRefreshTokenDbRepository implements AgentRefreshTokenRepository {
  constructor(private readonly dbClient: AgentRefreshTokenTenantClient) {}

  createToken(token: AgentRefreshToken): TE.TaskEither<RefreshTokenCreateError, AgentRefreshToken> {
    return pipe(
      fromPromise(
        async () => {
          return this.dbClient.cx.agentRefreshToken.create({data: agentData(token)})
        },
        error => mapCreateError(error, "agent refresh create")
      ),
      TE.chainEitherKW(mapAgentToken)
    )
  }

  getByTokenHash(
    context: TenantContext,
    tokenHash: string
  ): TE.TaskEither<RefreshTokenGetError, DecoratedAgentRefreshToken<{occ: true}>> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.agentRefreshToken.findUnique({
            where: {organizationId_tokenHash: {organizationId: context.organizationId, tokenHash}}
          }),
        error => mapGetError(error, "agent refresh lookup")
      ),
      chainNullableToLeft("refresh_token_not_found" as const),
      TE.chainEitherKW(mapAgentToken)
    )
  }

  persistNewTokenUpdateOld(
    context: TenantContext,
    newToken: DecoratedActiveAgentRefreshToken<{occ: true}>,
    oldToken: UsedAgentRefreshToken,
    expectedOcc: bigint
  ): TE.TaskEither<RefreshTokenUpdateError, void> {
    return fromPromise(
      async () => {
        await this.dbClient.cx.agentRefreshToken.create({data: agentData(newToken)})
        await this.dbClient.cx.agentRefreshToken.update({
          where: {
            organizationId: context.organizationId,
            id: oldToken.id,
            occ: expectedOcc
          },
          data: {
            status: oldToken.status,
            usedAt: oldToken.usedAt,
            nextTokenId: oldToken.nextTokenId,
            occ: {increment: 1}
          }
        })
      },
      error => mapRotationError(error, Prisma.ModelName.AgentRefreshToken, "agent refresh rotate")
    )
  }

  revokeFamily(context: TenantContext, familyId: string): TE.TaskEither<RefreshTokenUpdateError, void> {
    return fromPromise(
      () =>
        this.dbClient.cx.agentRefreshToken
          .updateMany({
            where: {organizationId: context.organizationId, familyId},
            data: {status: RefreshTokenStatus.REVOKED, occ: {increment: 1}}
          })
          .then(() => undefined),
      error => mapUpdateError(error, "agent refresh revoke family")
    )
  }
}

function accountData(token: AccountRefreshToken) {
  return {
    id: token.id,
    tokenHash: token.tokenHash,
    familyId: token.familyId,
    accountId: token.accountId,
    sessionId: token.sessionId,
    providerId: token.providerId,
    status: token.status,
    usedAt: token.status === RefreshTokenStatus.USED ? token.usedAt : null,
    nextTokenId: token.status === RefreshTokenStatus.USED ? token.nextTokenId : null,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    occ: POSTGRES_BIGINT_LOWER_BOUND
  }
}

function agentData(token: AgentRefreshToken) {
  return {
    id: token.id,
    organizationId: token.organizationId,
    agentId: token.agentId,
    tokenHash: token.tokenHash,
    familyId: token.familyId,
    status: token.status,
    usedAt: token.status === RefreshTokenStatus.USED ? token.usedAt : null,
    nextTokenId: token.status === RefreshTokenStatus.USED ? token.nextTokenId : null,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    occ: POSTGRES_BIGINT_LOWER_BOUND
  }
}

function mapAccountToken(
  record: PrismaAccountRefreshToken
): E.Either<RefreshTokenValidationError, DecoratedAccountRefreshToken<{occ: true}>> {
  return AccountRefreshTokenFactory.validate({...record, entityType: "account"}, {occ: true})
}

function mapAgentToken(
  record: PrismaAgentRefreshToken
): E.Either<RefreshTokenValidationError, DecoratedAgentRefreshToken<{occ: true}>> {
  const result = AgentRefreshTokenFactory.validate({...record, entityType: "agent"}, {occ: true})
  if (E.isLeft(result)) Logger.error("Agent refresh token mapping failed", result.left)
  return result
}

function mapCreateError(error: unknown, operation: string): RefreshTokenCreateError {
  Logger.error(`${operation} failed`, error instanceof Error ? error.name : "non_error")
  return "unknown_error"
}

function mapGetError(error: unknown, operation: string): RefreshTokenGetError {
  Logger.error(`${operation} failed`, error instanceof Error ? error.name : "non_error")
  return "unknown_error"
}

function mapUpdateError(error: unknown, operation: string): RefreshTokenUpdateError {
  Logger.error(`${operation} failed`, error instanceof Error ? error.name : "non_error")
  return "unknown_error"
}

function mapRotationError(error: unknown, model: Prisma.ModelName, operation: string): RefreshTokenUpdateError {
  if (isPrismaRecordNotFoundError(error, model)) return "refresh_token_concurrent_update"
  return mapUpdateError(error, operation)
}
