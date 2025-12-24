import {Injectable, Logger} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import * as E from "fp-ts/Either"
import {Prisma, RefreshToken as PrismaRefreshToken} from "@prisma/client"
import {
  RefreshToken,
  RefreshTokenFactory,
  DecoratedRefreshToken,
  RefreshTokenStatus,
  UsedUserRefreshToken,
  DecoratedUnusedUserRefreshToken,
  DecoratedUnusedAgentRefreshToken,
  UsedAgentRefreshToken,
  RefreshTokenValidationError,
  RefreshTokenDecoratorSelector
} from "@domain"
import {
  RefreshTokenCreateError,
  RefreshTokenGetError,
  RefreshTokenRepository,
  RefreshTokenUpdateError
} from "@services/auth"
import {DatabaseClient} from "./database-client"

@Injectable()
export class RefreshTokenDbRepository implements RefreshTokenRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  createToken(token: DecoratedRefreshToken<{occ: true}>): TaskEither<RefreshTokenCreateError, RefreshToken> {
    return pipe(
      TE.tryCatch(
        async () => {
          const prismaData = mapDomainTokenToPrismaForCreate(token)
          const created = await this.dbClient.refreshToken.create({
            data: prismaData
          })
          return created
        },
        error => {
          Logger.error("Error creating refresh token")
          Logger.error(error)
          return "unknown_error" as const
        }
      ),
      TE.chainEitherKW(prismaToken => mapPrismaTokenToDomain(prismaToken, {occ: true}))
    )
  }

  getByTokenHash(tokenHash: string): TaskEither<RefreshTokenGetError, DecoratedRefreshToken<{occ: true}>> {
    return pipe(
      TE.tryCatch(
        async () => {
          const token = await this.dbClient.refreshToken.findUnique({
            where: {tokenHash}
          })
          if (!token) throw new RefreshTokenNotFoundError()
          return token
        },
        error => {
          if (error instanceof RefreshTokenNotFoundError) return "refresh_token_not_found" as const
          Logger.error("Error retrieving refresh token", error)
          return "unknown_error" as const
        }
      ),
      TE.chainEitherKW(prismaToken => mapPrismaTokenToDomain(prismaToken, {occ: true}))
    )
  }

  persistNewTokenUpdateOldForUser(
    newTokenToPersist: DecoratedUnusedUserRefreshToken<{occ: true}>,
    oldTokenToUpdate: UsedUserRefreshToken,
    occCheckOldToken: bigint
  ): TaskEither<RefreshTokenUpdateError, void> {
    return this.persistNewTokenUpdateOldToken(oldTokenToUpdate, occCheckOldToken, newTokenToPersist)
  }

  persistNewTokenUpdateOldForAgent(
    newTokenToPersist: DecoratedUnusedAgentRefreshToken<{occ: true}>,
    oldTokenToUpdate: UsedAgentRefreshToken,
    occCheckOldToken: bigint
  ): TaskEither<RefreshTokenUpdateError, void> {
    return this.persistNewTokenUpdateOldToken(oldTokenToUpdate, occCheckOldToken, newTokenToPersist)
  }

  private persistNewTokenUpdateOldToken(
    oldTokenToUpdate: RefreshToken,
    occCheckOldToken: bigint,
    newTokenToPersist: DecoratedRefreshToken<{occ: true}>
  ): TaskEither<RefreshTokenUpdateError, void> {
    const oldTokenData = mapDomainTokenToPrismaForUpdate(oldTokenToUpdate)
    const newTokenData = mapDomainTokenToPrismaForCreate(newTokenToPersist)

    return TE.tryCatch(
      async () => {
        await this.dbClient.$transaction(async tx => {
          // Update existing token
          const updated = await tx.refreshToken.update({
            where: {
              id: oldTokenToUpdate.id,
              occ: occCheckOldToken
            },
            data: {
              ...oldTokenData,
              occ: {
                increment: 1
              }
            }
          })

          // Validate that a token was updated
          if (!updated) throw new RefreshTokenNotFoundError()

          // Create new token
          await tx.refreshToken.create({
            data: newTokenData
          })
        })
      },
      error => {
        if (error instanceof RefreshTokenNotFoundError) return "refresh_token_concurrent_update" as const

        Logger.error("Error updating refresh token")
        Logger.error(error)
        return "unknown_error" as const
      }
    )
  }

  revokeFamily(familyId: string): TaskEither<RefreshTokenUpdateError, void> {
    return TE.tryCatch(
      async () => {
        await this.dbClient.refreshToken.updateMany({
          where: {familyId},
          data: {
            status: RefreshTokenStatus.REVOKED,
            occ: {
              increment: 1
            }
          }
        })
      },
      error => {
        Logger.error("Error revoking token family", error)
        return "unknown_error" as const
      }
    )
  }
}

function getUsedTokenProp(token: RefreshToken): {usedAt: Date | null; nextTokenId: string | null} {
  if (token.status !== RefreshTokenStatus.USED) {
    return {
      usedAt: null,
      nextTokenId: null
    }
  }

  return {
    usedAt: token.usedAt,
    nextTokenId: token.nextTokenId
  }
}

function mapDomainTokenToPrismaForUpdate(token: RefreshToken): Prisma.RefreshTokenUpdateInput {
  const {usedAt, nextTokenId} = getUsedTokenProp(token)

  const baseData = {
    id: token.id,
    tokenHash: token.tokenHash,
    familyId: token.familyId,
    status: token.status,
    usedAt,
    nextTokenId,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt
  }

  let userRef: Prisma.UserCreateNestedOneWithoutRefreshTokensInput | undefined = undefined
  let agentRef: Prisma.AgentCreateNestedOneWithoutRefreshTokensInput | undefined = undefined

  if (token.entityType === "user") {
    userRef = {
      connect: {id: token.userId}
    }
  } else {
    agentRef = {
      connect: {id: token.agentId}
    }
  }

  return {
    ...baseData,
    ...(userRef !== undefined && {users: userRef}),
    ...(agentRef !== undefined && {agents: agentRef})
  }
}

function mapDomainTokenToPrismaForCreate(token: DecoratedRefreshToken<{occ: true}>): Prisma.RefreshTokenCreateInput {
  const {usedAt, nextTokenId} = getUsedTokenProp(token)

  const baseData = {
    id: token.id,
    tokenHash: token.tokenHash,
    familyId: token.familyId,
    status: token.status,
    usedAt,
    nextTokenId,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    occ: token.occ
  }

  let userRef: Prisma.UserCreateNestedOneWithoutRefreshTokensInput | undefined = undefined
  let agentRef: Prisma.AgentCreateNestedOneWithoutRefreshTokensInput | undefined = undefined

  if (token.entityType === "user") {
    userRef = {
      connect: {id: token.userId}
    }
  } else {
    agentRef = {
      connect: {id: token.agentId}
    }
  }

  return {
    ...baseData,
    ...(userRef !== undefined && {users: userRef}),
    ...(agentRef !== undefined && {agents: agentRef})
  }
}

function mapPrismaTokenToDomain<T extends RefreshTokenDecoratorSelector>(
  prismaToken: PrismaRefreshToken,
  selectors?: T
): E.Either<RefreshTokenValidationError, DecoratedRefreshToken<T>> {
  const data = {
    createdAt: prismaToken.createdAt,
    expiresAt: prismaToken.expiresAt,
    id: prismaToken.id,
    tokenHash: prismaToken.tokenHash,
    familyId: prismaToken.familyId,
    status: prismaToken.status as RefreshTokenStatus,
    usedAt: prismaToken.usedAt || undefined,
    nextTokenId: prismaToken.nextTokenId || undefined,
    entityType: prismaToken.userId ? "user" : "agent",
    userId: prismaToken.userId || undefined,
    agentId: prismaToken.agentId || undefined,
    occ: prismaToken.occ
  }

  return RefreshTokenFactory.validate<T>(data, selectors)
}

class RefreshTokenNotFoundError extends Error {
  constructor() {
    super("refresh_token_not_found")
  }
}
