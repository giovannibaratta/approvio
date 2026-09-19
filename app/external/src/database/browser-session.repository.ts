import {fromEitherPromise, fromPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {Session, SessionState, SessionFactory, SessionValidationError} from "@domain"
import {RepositoryDependencyError, SessionRepository, SessionRepositoryError} from "@services"
import * as E from "fp-ts/Either"
import {isPrismaRecordNotFoundError} from "./errors"
import {BrowserSession, Prisma} from "@prisma/client"
import * as TE from "fp-ts/TaskEither"
import {SessionDatabaseClient} from "./capability-database-client"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"

@Injectable()
export class BrowserSessionDbRepository implements SessionRepository {
  constructor(private readonly sessions: SessionDatabaseClient) {}

  getByAccountAndPrincipal(accountId: string, sessionId: string): TE.TaskEither<SessionRepositoryError, Session> {
    return fromEitherPromise(
      async () => {
        const session = await this.sessions.transactional(tx =>
          tx.browserSession.findUnique({where: {accountId_id: {accountId, id: sessionId}}})
        )
        return session ? mapSession(session) : E.left("session_not_found" as const)
      },
      error => this.mapError(error, "get_by_account_and_id")
    )
  }

  updateContext(
    session: Session
  ): TE.TaskEither<SessionValidationError | "concurrent_modification_error" | RepositoryDependencyError, Session> {
    return fromEitherPromise(
      async () => {
        return this.sessions.transactional(async tx => {
          const persisted = await tx.browserSession.update({
            where: {
              id: session.id,
              accountId: session.accountId,
              occ: session.occ
            },
            data: {
              selectedOrganizationId: session.selectedOrganizationId ?? null,
              contextVersion: session.contextVersion,
              updatedAt: session.updatedAt,
              occ: {increment: 1}
            }
          })
          return mapSession(persisted)
        })
      },
      error => {
        if (isPrismaRecordNotFoundError(error, Prisma.ModelName.BrowserSession))
          return "concurrent_modification_error" as const
        return this.mapError(error, "update_context")
      }
    )
  }

  revokeActiveByAccountAndId(
    accountId: string,
    sessionId: string
  ): TE.TaskEither<"session_not_found" | RepositoryDependencyError, void> {
    return fromPromise(
      async () => {
        await this.sessions.transactional(tx =>
          tx.browserSession.update({
            where: {id: sessionId, accountId, status: "active"},
            data: {status: "revoked", occ: {increment: 1}},
            select: {id: true}
          })
        )
      },
      error => {
        if (isPrismaRecordNotFoundError(error, Prisma.ModelName.BrowserSession)) return "session_not_found" as const
        return this.mapError(error, "revoke_active_by_account_and_id")
      }
    )
  }

  create(session: SessionState): TE.TaskEither<SessionValidationError | RepositoryDependencyError, Session> {
    return fromEitherPromise(
      async () => {
        const persisted = await this.sessions.transactional(tx =>
          tx.browserSession.create({
            data: {
              ...session,
              selectedOrganizationId: session.selectedOrganizationId ?? null,
              occ: POSTGRES_BIGINT_LOWER_BOUND
            }
          })
        )
        return mapSession(persisted)
      },
      error => {
        Logger.error("Browser session repository create failed", error instanceof Error ? error.name : "non_error")
        return "repository_dependency_error"
      }
    )
  }

  private mapError(error: unknown, operation: string): RepositoryDependencyError {
    Logger.error(`Browser session repository ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "repository_dependency_error"
  }
}

function mapSession(session: BrowserSession): E.Either<SessionValidationError, Session> {
  const validated = SessionFactory.validate({
    ...session,
    selectedOrganizationId: session.selectedOrganizationId ?? undefined
  })
  return E.map((value: SessionState) => ({...value, occ: session.occ}))(validated)
}
