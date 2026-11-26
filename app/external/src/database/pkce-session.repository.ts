import {PkceSessionFactory, PkceSessionValidationError, PkceSessionData, PkceStorageData} from "@domain"
import {Either} from "fp-ts/Either"
import {fromPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {PkceError, PkceSessionRepository} from "@services/auth"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {PlatformEncryptionService} from "../kms"
import {SessionDatabaseClient} from "./capability-database-client"
import {PkceSession, Prisma} from "@prisma/client"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {isPrismaRecordNotFoundError} from "./errors"
import {chainNullableToLeft} from "./utils"

@Injectable()
export class PkceSessionDbRepository implements PkceSessionRepository {
  constructor(
    private readonly dbClient: SessionDatabaseClient,
    private readonly encryptionService: PlatformEncryptionService
  ) {}

  storePkceData(state: string, data: PkceStorageData): TE.TaskEither<PkceError, void> {
    const stepUpTarget = data.flow === "step_up" ? data.stepUpTarget : undefined

    return pipe(
      this.encryptionService.encryptPkce(state, data.providerId, data.codeVerifier),
      TE.chainW(encCodeVerifier =>
        fromPromise(
          async () => {
            await this.dbClient.transactional(tx =>
              tx.pkceSession.create({
                data: {
                  state,
                  encCodeVerifier,
                  redirectUri: data.redirectUri,
                  oidcState: data.oidcState,
                  providerId: data.providerId,
                  flow: data.flow,
                  sessionId: data.flow === "step_up" ? data.sessionId : null,
                  stepUpOrganizationId: stepUpTarget?.organizationId ?? null,
                  stepUpOperation: stepUpTarget?.operation ?? null,
                  stepUpResourceId: stepUpTarget?.resourceId ?? null,
                  stepUpContextVersion: stepUpTarget?.contextVersion ?? null,
                  createdAt: data.createdAt,
                  expiresAt: data.expiresAt,
                  usedAt: null,
                  occ: POSTGRES_BIGINT_LOWER_BOUND
                }
              })
            )
          },
          error => this.mapStorageError(error, "store")
        )
      )
    )
  }

  retrievePkceData(state: string): TE.TaskEither<PkceError, PkceSessionData> {
    return pipe(
      fromPromise(
        () => this.dbClient.transactional(tx => tx.pkceSession.findUnique({where: {state}})),
        error => this.mapStorageError(error, "retrieve")
      ),
      chainNullableToLeft("pkce_code_not_found" as const),
      TE.chainW(session =>
        pipe(
          this.encryptionService.decryptPkce(session.state, session.providerId, session.encCodeVerifier),
          TE.chainEitherKW(codeVerifier => mapSession(session, codeVerifier))
        )
      )
    )
  }

  deletePkceData(state: string): TE.TaskEither<PkceError, void> {
    return fromPromise(
      async () => {
        await this.dbClient.transactional(tx => tx.pkceSession.delete({where: {state}, select: {state: true}}))
      },
      error => {
        if (isPrismaRecordNotFoundError(error, Prisma.ModelName.PkceSession)) return "pkce_code_not_found" as const
        return this.mapStorageError(error, "delete")
      }
    )
  }

  updatePkceSession(sessionData: PkceSessionData, currentOcc: bigint): TE.TaskEither<PkceError, void> {
    return pipe(
      this.encryptionService.encryptPkce(sessionData.state, sessionData.providerId, sessionData.codeVerifier),
      TE.chainW(encCodeVerifier =>
        fromPromise(
          async () => {
            await this.dbClient.transactional(tx =>
              tx.pkceSession.update({
                where: {state: sessionData.state, occ: currentOcc},
                data: {
                  encCodeVerifier,
                  redirectUri: sessionData.redirectUri,
                  oidcState: sessionData.oidcState,
                  expiresAt: sessionData.expiresAt,
                  usedAt: sessionData.usedAt ?? null,
                  occ: {increment: 1}
                },
                select: {state: true}
              })
            )
          },
          error => {
            if (isPrismaRecordNotFoundError(error, Prisma.ModelName.PkceSession))
              return "pkce_code_concurrency_conflict" as const
            return this.mapStorageError(error, "update")
          }
        )
      )
    )
  }

  private mapStorageError(error: unknown, operation: string): PkceError {
    Logger.error(`PKCE session repository ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "pkce_code_storage_failed"
  }
}

function mapSession(session: PkceSession, codeVerifier: string): Either<PkceSessionValidationError, PkceSessionData> {
  const stepUpTarget =
    session.stepUpOrganizationId === null &&
    session.stepUpOperation === null &&
    session.stepUpResourceId === null &&
    session.stepUpContextVersion === null
      ? undefined
      : {
          organizationId: session.stepUpOrganizationId ?? undefined,
          operation: session.stepUpOperation ?? undefined,
          resourceId: session.stepUpResourceId ?? undefined,
          contextVersion: session.stepUpContextVersion ?? undefined
        }
  return PkceSessionFactory.validate({
    state: session.state,
    codeVerifier,
    redirectUri: session.redirectUri,
    oidcState: session.oidcState,
    providerId: session.providerId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    occ: session.occ,
    usedAt: session.usedAt ?? undefined,
    flow: session.flow,
    sessionId: session.sessionId ?? undefined,
    stepUpTarget
  })
}
