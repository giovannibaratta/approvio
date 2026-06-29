import {Injectable, Logger} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {DatabaseClient} from "./database-client"
import {PkceError, PkceStorageData, PkceSessionData, PkceSessionRepository} from "@services/auth"
import {EncryptionService} from "../kms"
import {pipe} from "fp-ts/function"

@Injectable()
export class PkceSessionDbRepository implements PkceSessionRepository {
  constructor(
    private readonly dbClient: DatabaseClient,
    private readonly encryptionService: EncryptionService
  ) {}

  storePkceData(state: string, data: PkceStorageData): TaskEither<PkceError, void> {
    return pipe(
      this.encryptionService.encrypt(data.codeVerifier),
      TE.chainW(encryptedVerifier =>
        TE.tryCatch(
          async () => {
            await this.dbClient.cx.pkceSession.create({
              data: {
                state,
                codeVerifier: encryptedVerifier,
                redirectUri: data.redirectUri,
                oidcState: data.oidcState,
                expiresAt: data.expiresAt,
                occ: 0
              }
            })
          },
          error => {
            Logger.error("Error storing PKCE data", error)
            return "pkce_code_storage_failed" as const
          }
        )
      )
    )
  }

  retrievePkceData(state: string): TaskEither<PkceError, PkceSessionData> {
    return pipe(
      TE.tryCatch(
        async () => {
          const session = await this.dbClient.cx.pkceSession.findUnique({
            where: {state}
          })

          if (!session) throw new Error("PKCE session not found")
          return session
        },
        error => {
          Logger.error("Error retrieving PKCE data", error)
          if (error instanceof Error && error.message === "PKCE session not found")
            return "pkce_code_not_found" as const

          return "pkce_code_storage_failed" as const
        }
      ),
      TE.chainW(session =>
        pipe(
          this.encryptionService.decrypt(session.codeVerifier),
          TE.map(
            (decryptedVerifier): PkceSessionData => ({
              state: session.state,
              codeVerifier: decryptedVerifier,
              redirectUri: session.redirectUri,
              oidcState: session.oidcState,
              providerId: session.providerId,
              expiresAt: session.expiresAt,
              occ: session.occ,
              usedAt: session.usedAt || undefined
            })
          )
        )
      )
    )
  }

  deletePkceData(state: string): TaskEither<PkceError, void> {
    return TE.tryCatch(
      async () => {
        await this.dbClient.cx.pkceSession.delete({
          where: {state}
        })
      },
      error => {
        Logger.error("Error deleting PKCE data", error)
        return "pkce_code_storage_failed" as const
      }
    )
  }

  updatePkceSession(sessionData: PkceSessionData, currentOcc: bigint): TaskEither<PkceError, void> {
    return pipe(
      this.encryptionService.encrypt(sessionData.codeVerifier),
      TE.chainW(encryptedVerifier =>
        TE.tryCatch(
          async () => {
            const result = await this.dbClient.cx.pkceSession.updateMany({
              where: {
                state: sessionData.state,
                occ: currentOcc
              },
              data: {
                codeVerifier: encryptedVerifier,
                redirectUri: sessionData.redirectUri,
                oidcState: sessionData.oidcState,
                expiresAt: sessionData.expiresAt,
                usedAt: sessionData.usedAt,
                occ: currentOcc + 1n
              }
            })

            if (result.count === 0) throw new Error("PKCE session OCC conflict or not found")
          },
          error => {
            Logger.error("Error updating PKCE session", error)
            if (error instanceof Error && error.message === "PKCE session OCC conflict or not found")
              return "pkce_code_not_found" as const

            return "pkce_code_storage_failed" as const
          }
        )
      )
    )
  }
}
