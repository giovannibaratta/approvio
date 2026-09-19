import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {fromPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {PlatformAccount} from "@prisma/client"
import {Account, AccountFactory, AccountValidationError} from "@domain"
import {PlatformIdentityRepository, RepositoryDependencyError} from "@services"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {chainNullableToLeft} from "./utils"
import {isPrismaUniqueConstraintError} from "./errors"
import {IdentityDatabaseClient} from "./capability-database-client"

@Injectable()
export class PlatformIdentityDbRepository implements PlatformIdentityRepository {
  constructor(private readonly identity: IdentityDatabaseClient) {}

  getAccountByIdentity(input: {
    readonly providerId: string
    readonly issuer: string
    readonly subject: string
  }): TE.TaskEither<"account_not_found" | AccountValidationError | RepositoryDependencyError, Account> {
    return pipe(
      fromPromise(
        () =>
          this.identity.transactional(tx =>
            tx.platformAccountIdentity.findUnique({
              where: {
                providerId_issuer_subject: input
              },
              include: {platformAccounts: true}
            })
          ),
        error => this.mapError(error, "get_account_by_identity")
      ),
      chainNullableToLeft("account_not_found" as const),
      TE.map(identity => identity.platformAccounts),
      TE.chainEitherKW(account => this.validate(account))
    )
  }

  createAccountWithIdentity(input: {
    readonly identityId: string
    readonly providerId: string
    readonly issuer: string
    readonly subject: string
    readonly account: Account
  }): TE.TaskEither<"identity_already_linked" | AccountValidationError | RepositoryDependencyError, Account> {
    return pipe(
      fromPromise(
        async () => {
          return this.identity.transactional(async tx => {
            const account = await tx.platformAccount.create({
              data: {
                ...input.account,
                occ: POSTGRES_BIGINT_LOWER_BOUND
              }
            })
            await tx.platformAccountIdentity.create({
              data: {
                id: input.identityId,
                accountId: account.id,
                providerId: input.providerId,
                issuer: input.issuer,
                subject: input.subject,
                createdAt: input.account.createdAt,
                occ: POSTGRES_BIGINT_LOWER_BOUND
              }
            })
            return account
          })
        },
        error => {
          if (isPrismaUniqueConstraintError(error, ["provider_id", "issuer", "subject"]))
            return "identity_already_linked" as const
          return this.mapError(error, "create_account_with_identity")
        }
      ),
      TE.chainEitherKW(account => this.validate(account))
    )
  }

  getAccountById(
    accountId: string
  ): TE.TaskEither<"account_not_found" | AccountValidationError | RepositoryDependencyError, Account> {
    return pipe(
      fromPromise(
        () => this.identity.transactional(tx => tx.platformAccount.findUnique({where: {id: accountId}})),
        error => this.mapError(error, "get_account_by_id")
      ),
      chainNullableToLeft("account_not_found" as const),
      TE.orElseFirstIOK(error => () => {
        if (error === "account_not_found") Logger.warn(`Platform account ${accountId} not found during getAccountById`)
      }),
      TE.chainEitherKW(account => this.validate(account))
    )
  }

  private validate(account: PlatformAccount): E.Either<AccountValidationError, Account> {
    return AccountFactory.validate({
      id: account.id,
      displayName: account.displayName,
      profileEmail: account.profileEmail,
      status: account.status,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt
    })
  }

  private mapError(error: unknown, operation: string): RepositoryDependencyError {
    Logger.error(`Platform identity repository ${operation} failed`, error)
    return "repository_dependency_error"
  }
}
