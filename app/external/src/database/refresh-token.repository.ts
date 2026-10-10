import {Injectable, Logger} from "@nestjs/common"
import {
  AccountRefreshToken,
  AccountRefreshTokenFactory,
  AgentRefreshToken,
  AgentRefreshTokenFactory,
  RefreshTokenStatus,
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
import {RefreshToken as PrismaAccountRefreshToken, AgentRefreshToken as PrismaAgentRefreshToken} from "@prisma/client"
import {getStringAsEnum} from "@utils"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {SessionDatabaseClient} from "./capability-database-client"
import {AgentRefreshTokenTenantClient} from "./tenant-database-clients"

@Injectable()
export class AccountRefreshTokenDbRepository implements AccountRefreshTokenRepository {
  constructor(private readonly sessions: SessionDatabaseClient) {}

  createToken(token: AccountRefreshToken): TE.TaskEither<RefreshTokenCreateError, AccountRefreshToken> {
    return pipe(
      TE.tryCatch(
        () => this.sessions.transactional(tx => tx.refreshToken.create({data: accountData(token)})),
        error => mapCreateError(error, "account refresh create")
      ),
      TE.chainEitherKW(record => E.mapLeft(() => "unknown_error" as const)(mapAccountToken(record)))
    )
  }

  getByTokenHash(tokenHash: string): TE.TaskEither<RefreshTokenGetError, DecoratedAccountRefreshToken<{occ: true}>> {
    return pipe(
      TE.tryCatch(
        async () => {
          const token = await this.sessions.transactional(tx => tx.refreshToken.findUnique({where: {tokenHash}}))
          if (!token) throw new TokenNotFoundError()
          return token
        },
        error => mapGetError(error, "account refresh lookup")
      ),
      TE.chainEitherKW(mapAccountToken)
    )
  }

  persistNewTokenUpdateOld(
    newToken: DecoratedActiveAccountRefreshToken<{occ: true}>,
    oldToken: UsedAccountRefreshToken,
    expectedOcc: bigint
  ): TE.TaskEither<RefreshTokenUpdateError, void> {
    return TE.tryCatch(
      async () => {
        await this.sessions.transactional(async tx => {
          // The used token references its successor. Insert that successor before
          // updating nextTokenId so the self-referential FK remains valid.
          await tx.refreshToken.create({data: accountData(newToken)})

          // The predicate includes the expected OCC and active state. updateMany
          // exposes its affected-row count so a stale or replayed rotation becomes
          // a conflict instead of overwriting the token.
          const updated = await tx.refreshToken.updateMany({
            where: {id: oldToken.id, occ: expectedOcc, status: RefreshTokenStatus.ACTIVE},
            data: {
              status: oldToken.status,
              usedAt: oldToken.usedAt,
              nextTokenId: oldToken.nextTokenId,
              occ: {increment: 1}
            }
          })
          // Validate that a token was updated
          if (updated.count !== 1) throw new TokenConflictError()
        })
      },
      error => mapUpdateError(error, "account refresh rotate")
    )
  }

  revokeFamily(familyId: string): TE.TaskEither<RefreshTokenUpdateError, void> {
    return TE.tryCatch(
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

  createToken(
    context: TenantContext,
    token: AgentRefreshToken
  ): TE.TaskEither<RefreshTokenCreateError, AgentRefreshToken> {
    return pipe(
      TE.tryCatch(
        async () => {
          if (context.organizationId !== token.organizationId) throw new TokenNotFoundError()
          return this.dbClient.cx.agentRefreshToken.create({data: agentData(token)})
        },
        error => mapCreateError(error, "agent refresh create")
      ),
      TE.chainEitherKW(record => E.mapLeft(() => "unknown_error" as const)(mapAgentToken(record)))
    )
  }

  getByTokenHash(
    context: TenantContext,
    tokenHash: string
  ): TE.TaskEither<RefreshTokenGetError, DecoratedAgentRefreshToken<{occ: true}>> {
    return pipe(
      TE.tryCatch(
        async () => {
          const token = await this.dbClient.cx.agentRefreshToken.findUnique({
            where: {organizationId_tokenHash: {organizationId: context.organizationId, tokenHash}}
          })
          if (!token) throw new TokenNotFoundError()
          return token
        },
        error => mapGetError(error, "agent refresh lookup")
      ),
      TE.chainEitherKW(mapAgentToken)
    )
  }

  persistNewTokenUpdateOld(
    context: TenantContext,
    newToken: DecoratedActiveAgentRefreshToken<{occ: true}>,
    oldToken: UsedAgentRefreshToken,
    expectedOcc: bigint
  ): TE.TaskEither<RefreshTokenUpdateError, void> {
    return TE.tryCatch(
      async () => {
        if (context.organizationId !== newToken.organizationId || context.organizationId !== oldToken.organizationId)
          throw new TokenConflictError()
        await this.dbClient.cx.agentRefreshToken.create({data: agentData(newToken)})
        const updated = await this.dbClient.cx.agentRefreshToken.updateMany({
          where: {
            organizationId: context.organizationId,
            id: oldToken.id,
            occ: expectedOcc,
            status: RefreshTokenStatus.ACTIVE
          },
          data: {
            status: oldToken.status,
            usedAt: oldToken.usedAt,
            nextTokenId: oldToken.nextTokenId,
            occ: {increment: 1}
          }
        })
        if (updated.count !== 1) throw new TokenConflictError()
      },
      error => mapUpdateError(error, "agent refresh rotate")
    )
  }

  revokeFamily(context: TenantContext, familyId: string): TE.TaskEither<RefreshTokenUpdateError, void> {
    return TE.tryCatch(
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
    occ: 0n
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
    occ: 0n
  }
}

function mapAccountToken(
  record: PrismaAccountRefreshToken
): E.Either<RefreshTokenGetError, DecoratedAccountRefreshToken<{occ: true}>> {
  const status = getStringAsEnum(record.status, RefreshTokenStatus)
  if (!status) return E.left("unknown_error")
  return AccountRefreshTokenFactory.validate({...record, status, entityType: "account"}, {occ: true})
}

function mapAgentToken(
  record: PrismaAgentRefreshToken
): E.Either<RefreshTokenGetError, DecoratedAgentRefreshToken<{occ: true}>> {
  const status = getStringAsEnum(record.status, RefreshTokenStatus)
  if (!status) return E.left("unknown_error")
  const result = AgentRefreshTokenFactory.validate({...record, status, entityType: "agent"}, {occ: true})
  if (E.isLeft(result)) Logger.error("Agent refresh token mapping failed", result.left)
  return result
}
function mapCreateError(error: unknown, operation: string): RefreshTokenCreateError {
  Logger.error(`${operation} failed`, error instanceof Error ? error.name : "non_error")
  return "unknown_error"
}
function mapGetError(error: unknown, operation: string): RefreshTokenGetError {
  if (error instanceof TokenNotFoundError) return "refresh_token_not_found"
  Logger.error(`${operation} failed`, error instanceof Error ? error.name : "non_error")
  return "unknown_error"
}
function mapUpdateError(error: unknown, operation: string): RefreshTokenUpdateError {
  if (error instanceof TokenConflictError) return "refresh_token_concurrent_update"
  Logger.error(`${operation} failed`, error instanceof Error ? error.name : "non_error")
  return "unknown_error"
}
class TokenNotFoundError extends Error {}
class TokenConflictError extends Error {}
