import {Injectable, Logger} from "@nestjs/common"
import {PkceError, PkceSessionData, PkceSessionRepository, PkceStorageData} from "@services/auth"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {PlatformEncryptionService} from "../kms"
import {SessionDatabaseClient} from "./capability-database-client"

@Injectable()
export class PkceSessionDbRepository implements PkceSessionRepository {
  constructor(
    private readonly sessions: SessionDatabaseClient,
    private readonly encryption: PlatformEncryptionService
  ) {}

  storePkceData(state: string, data: PkceStorageData): TE.TaskEither<PkceError, void> {
    const stepUpTarget = data.flow === "step_up" ? data.stepUpTarget : undefined
    return pipe(
      this.encryption.encryptPkce(state, data.providerId, data.codeVerifier),
      TE.mapLeft(mapCryptoError),
      TE.chainW(encCodeVerifier =>
        TE.tryCatch(
          async () => {
            await this.sessions.transactional(tx =>
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
                  createdAt: new Date(),
                  expiresAt: data.expiresAt,
                  usedAt: null,
                  occ: 0n
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
      TE.tryCatch(
        async () => {
          const session = await this.sessions.transactional(tx => tx.pkceSession.findUnique({where: {state}}))
          if (!session) throw new PkceNotFoundError()
          return session
        },
        error => this.mapStorageError(error, "retrieve")
      ),
      TE.chainW(session =>
        pipe(
          this.encryption.decryptPkce(session.state, session.providerId, session.encCodeVerifier),
          TE.mapLeft(mapCryptoError),
          TE.chainEitherKW(codeVerifier => mapSession(session, codeVerifier))
        )
      )
    )
  }

  deletePkceData(state: string): TE.TaskEither<PkceError, void> {
    return TE.tryCatch(
      async () => {
        const deleted = await this.sessions.transactional(tx => tx.pkceSession.deleteMany({where: {state}}))
        if (deleted.count !== 1) throw new PkceNotFoundError()
      },
      error => this.mapStorageError(error, "delete")
    )
  }

  updatePkceSession(sessionData: PkceSessionData, occCheck: bigint): TE.TaskEither<PkceError, void> {
    return pipe(
      this.encryption.encryptPkce(sessionData.state, sessionData.providerId, sessionData.codeVerifier),
      TE.mapLeft(mapCryptoError),
      TE.chainW(encCodeVerifier =>
        TE.tryCatch(
          async () => {
            const updated = await this.sessions.transactional(tx =>
              tx.pkceSession.updateMany({
                where: {state: sessionData.state, occ: occCheck},
                data: {
                  encCodeVerifier,
                  expiresAt: sessionData.expiresAt,
                  usedAt: sessionData.usedAt ?? null,
                  occ: {increment: 1}
                }
              })
            )
            if (updated.count !== 1) throw new PkceConflictError()
          },
          error => this.mapStorageError(error, "update")
        )
      )
    )
  }

  private mapStorageError(error: unknown, operation: string): PkceError {
    if (error instanceof PkceNotFoundError) return "pkce_code_not_found"
    if (error instanceof PkceConflictError) return "pkce_code_concurrency_conflict"
    Logger.error(`PKCE session repository ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "pkce_code_storage_failed"
  }
}

function mapSession(
  session: {
    readonly state: string
    readonly redirectUri: string
    readonly oidcState: string
    readonly providerId: string
    readonly flow: string
    readonly sessionId: string | null
    readonly stepUpOrganizationId: string | null
    readonly stepUpOperation: string | null
    readonly stepUpResourceId: string | null
    readonly stepUpContextVersion: bigint | null
    readonly expiresAt: Date
    readonly occ: bigint
    readonly usedAt: Date | null
  },
  codeVerifier: string
): import("fp-ts/Either").Either<PkceError, PkceSessionData> {
  const stepUpValues = [
    session.stepUpOrganizationId,
    session.stepUpOperation,
    session.stepUpResourceId,
    session.stepUpContextVersion
  ]
  const hasStepUp = stepUpValues.every(value => value !== null)
  if (!hasStepUp && stepUpValues.some(value => value !== null)) return {_tag: "Left", left: "pkce_code_storage_failed"}
  if (session.flow !== "initial_login" && session.flow !== "initial_cli_login" && session.flow !== "step_up")
    return {_tag: "Left", left: "pkce_code_storage_failed"}
  if (
    (session.flow === "initial_login" || session.flow === "initial_cli_login") &&
    (session.sessionId !== null || hasStepUp)
  )
    return {_tag: "Left", left: "pkce_code_storage_failed"}
  if (session.flow === "step_up" && (session.sessionId === null || !hasStepUp))
    return {_tag: "Left", left: "pkce_code_storage_failed"}
  if (
    session.stepUpOperation !== null &&
    session.stepUpOperation !== "admin_action" &&
    session.stepUpOperation !== "delete_organization"
  )
    return {_tag: "Left", left: "pkce_code_storage_failed"}
  const metadata = {
    state: session.state,
    codeVerifier,
    redirectUri: session.redirectUri,
    oidcState: session.oidcState,
    providerId: session.providerId,
    expiresAt: session.expiresAt,
    occ: session.occ,
    ...(session.usedAt === null ? {} : {usedAt: session.usedAt})
  }
  if (session.flow === "initial_login" || session.flow === "initial_cli_login")
    return {_tag: "Right", right: {...metadata, flow: session.flow}}
  return {
    _tag: "Right",
    right: {
      ...metadata,
      flow: "step_up",
      sessionId: session.sessionId!,
      stepUpTarget: {
        organizationId: session.stepUpOrganizationId!,
        operation: session.stepUpOperation!,
        resourceId: session.stepUpResourceId!,
        contextVersion: session.stepUpContextVersion!
      }
    }
  }
}

class PkceNotFoundError extends Error {}
class PkceConflictError extends Error {}

function mapCryptoError(
  error: "encryption_failed" | "decryption_failed" | "binding_mismatch" | "unsupported_format"
): PkceError {
  return error === "encryption_failed" || error === "decryption_failed" ? error : "pkce_code_storage_failed"
}
