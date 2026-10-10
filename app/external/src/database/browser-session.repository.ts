import {Injectable, Logger} from "@nestjs/common"
import {Session, SessionState, SessionFactory} from "@domain"
import {RepositoryDependencyError, SessionRepository} from "@services"
import * as E from "fp-ts/Either"
import {BrowserSession} from "@prisma/client"
import * as TE from "fp-ts/TaskEither"
import {SessionDatabaseClient} from "./capability-database-client"

type SessionError = "invalid_credential" | "organization_context_changed" | RepositoryDependencyError

@Injectable()
export class BrowserSessionDbRepository implements SessionRepository {
  constructor(private readonly sessions: SessionDatabaseClient) {}

  getByAccountAndPrincipal(accountId: string, sessionId: string): TE.TaskEither<SessionError, Session> {
    return TE.tryCatch(
      async () => {
        const session = await this.sessions.transactional(tx =>
          tx.browserSession.findUnique({where: {accountId_id: {accountId, id: sessionId}}})
        )
        if (!session || session.status !== "active" || session.expiresAt <= new Date())
          throw new InvalidCredentialError()
        return mapSession(session)
      },
      error => this.mapError(error, "get_by_account_and_id")
    )
  }

  updateContext(session: Session): TE.TaskEither<SessionError, Session> {
    return TE.tryCatch(
      async () => {
        return this.sessions.transactional(async tx => {
          const updated = await tx.browserSession.updateMany({
            where: {
              id: session.id,
              accountId: session.accountId,
              occ: session.occ,
              status: "active",
              expiresAt: {gt: new Date()}
            },
            data: {
              selectedOrganizationId: session.selectedOrganizationId ?? null,
              contextVersion: session.contextVersion,
              updatedAt: session.updatedAt,
              occ: {increment: 1}
            }
          })
          if (updated.count !== 1) throw new ContextChangedError()
          const persisted = await tx.browserSession.findUnique({
            where: {accountId_id: {accountId: session.accountId, id: session.id}}
          })
          if (!persisted) throw new ContextChangedError()
          return mapSession(persisted)
        })
      },
      error => this.mapError(error, "update_context")
    )
  }

  revokeByAccountAndId(accountId: string, sessionId: string): TE.TaskEither<SessionError, void> {
    return TE.tryCatch(
      async () => {
        const updated = await this.sessions.transactional(tx =>
          tx.browserSession.updateMany({
            where: {id: sessionId, accountId, status: "active"},
            data: {status: "revoked", occ: {increment: 1}}
          })
        )
        if (updated.count !== 1) throw new InvalidCredentialError()
      },
      error => this.mapError(error, "revoke_by_account_and_id")
    )
  }

  create(session: SessionState): TE.TaskEither<RepositoryDependencyError, Session> {
    return TE.tryCatch(
      async () => {
        const persisted = await this.sessions.transactional(tx =>
          tx.browserSession.create({
            data: {
              ...session,
              selectedOrganizationId: session.selectedOrganizationId ?? null,
              occ: 0n
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

  private mapError(error: unknown, operation: string): SessionError {
    if (error instanceof InvalidCredentialError) return "invalid_credential"
    if (error instanceof ContextChangedError || error instanceof SyntaxError) return "organization_context_changed"
    Logger.error(`Browser session repository ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "repository_dependency_error"
  }
}

function mapSession(session: BrowserSession): Session {
  const validated = SessionFactory.validate({
    ...session,
    selectedOrganizationId: session.selectedOrganizationId ?? undefined
  })
  if (E.isLeft(validated)) throw new InvalidCredentialError()
  return {...validated.right, occ: session.occ}
}

class InvalidCredentialError extends Error {}
class ContextChangedError extends Error {}
