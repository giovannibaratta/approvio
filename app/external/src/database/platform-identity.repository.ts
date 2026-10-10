import {Injectable, Logger} from "@nestjs/common"
import {PlatformAccount} from "@prisma/client"
import {Account, AccountFactory} from "@domain"
import {PlatformIdentityRepository, RepositoryDependencyError} from "@services"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {v7 as uuidv7} from "uuid"
import {isPrismaUniqueConstraintError} from "./errors"
import {IdentityDatabaseClient} from "./capability-database-client"

type IdentityError = "account_not_found" | "identity_exists" | RepositoryDependencyError

@Injectable()
export class PlatformIdentityDbRepository implements PlatformIdentityRepository {
  constructor(private readonly identity: IdentityDatabaseClient) {}

  resolveIdentity(input: {
    readonly providerId: string
    readonly issuer: string
    readonly subject: string
  }): TE.TaskEither<"account_not_found" | RepositoryDependencyError, Account> {
    return pipe(
      TE.tryCatch(
        async () => {
          const identity = await this.identity.transactional(tx =>
            tx.platformAccountIdentity.findUnique({
              where: {
                providerId_issuer_subject: input
              },
              include: {platformAccounts: true}
            })
          )
          if (!identity) throw new AccountNotFoundError()
          return identity.platformAccounts
        },
        error => this.mapError(error, "resolve_identity")
      ),
      TE.chainEitherKW(account => this.validate(account)),
      TE.mapLeft(error => (error === "account_not_found" ? error : "repository_dependency_error"))
    )
  }

  createIdentity(input: {
    readonly providerId: string
    readonly issuer: string
    readonly subject: string
    readonly account: Account
  }): TE.TaskEither<"identity_exists" | RepositoryDependencyError, Account> {
    return pipe(
      TE.tryCatch(
        async () => {
          return this.identity.transactional(async tx => {
            const account = await tx.platformAccount.create({
              data: {
                ...input.account,
                occ: 0n
              }
            })
            await tx.platformAccountIdentity.create({
              data: {
                id: uuidv7(),
                accountId: account.id,
                providerId: input.providerId,
                issuer: input.issuer,
                subject: input.subject,
                createdAt: input.account.createdAt,
                occ: 0n
              }
            })
            return account
          })
        },
        error => this.mapError(error, "create_identity")
      ),
      TE.chainEitherKW(account => this.validate(account)),
      TE.mapLeft(error => (error === "identity_exists" ? error : "repository_dependency_error"))
    )
  }

  getAccountById(accountId: string): TE.TaskEither<"account_not_found" | RepositoryDependencyError, Account> {
    return pipe(
      TE.tryCatch(
        async () => {
          const account = await this.identity.transactional(tx =>
            tx.platformAccount.findUnique({where: {id: accountId}})
          )
          if (!account) {
            Logger.warn(`Platform account ${accountId} not found during getAccountById`)
            throw new AccountNotFoundError()
          }
          return account
        },
        error => this.mapError(error, "get_account_by_id")
      ),
      TE.chainEitherKW(account => this.validate(account)),
      TE.mapLeft(error => {
        if (error === "account_not_found") return error
        if (error !== "repository_dependency_error")
          Logger.error(`Platform account ${accountId} failed validation`, error)
        return "repository_dependency_error" as const
      })
    )
  }

  private validate(account: PlatformAccount): E.Either<RepositoryDependencyError, Account> {
    if (account.status !== "active" && account.status !== "disabled") return E.left("repository_dependency_error")
    if (!account.profileEmail) return E.left("repository_dependency_error")
    return E.mapLeft(() => "repository_dependency_error" as const)(
      AccountFactory.validate({
        id: account.id,
        displayName: account.displayName,
        profileEmail: account.profileEmail,
        status: account.status,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt
      })
    )
  }

  private mapError(error: unknown, operation: string): IdentityError {
    if (error instanceof AccountNotFoundError) return "account_not_found"
    if (isPrismaUniqueConstraintError(error, ["provider_id", "issuer", "subject"])) return "identity_exists"
    Logger.error(`Platform identity repository ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "repository_dependency_error"
  }
}

class AccountNotFoundError extends Error {}
