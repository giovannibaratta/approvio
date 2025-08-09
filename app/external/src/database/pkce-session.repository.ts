import {Injectable, Logger} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {DatabaseClient} from "./database-client"
import {PkceError, PkceStorageData, PkceSessionData, PkceSessionRepository} from "@services/auth"

@Injectable()
export class PkceSessionDbRepository implements PkceSessionRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  storePkceData(state: string, data: PkceStorageData): TaskEither<PkceError, void> {
    return TE.tryCatch(
      async () => {
        await this.dbClient.pkceSession.create({
          data: {
            state,
            codeVerifier: data.codeVerifier,
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
  }

  retrievePkceData(state: string): TaskEither<PkceError, PkceSessionData> {
    return TE.tryCatch(
      async () => {
        const session = await this.dbClient.pkceSession.findUnique({
          where: {state}
        })

        if (!session) throw new Error("PKCE session not found")

        return {
          state: session.state,
          codeVerifier: session.codeVerifier,
          redirectUri: session.redirectUri,
          oidcState: session.oidcState,
          expiresAt: session.expiresAt,
          occ: session.occ,
          usedAt: session.usedAt || undefined
        }
      },
      error => {
        Logger.error("Error retrieving PKCE data", error)
        if (error instanceof Error && error.message === "PKCE session not found") return "pkce_code_not_found" as const

        return "pkce_code_storage_failed" as const
      }
    )
  }

  deletePkceData(state: string): TaskEither<PkceError, void> {
    return TE.tryCatch(
      async () => {
        await this.dbClient.pkceSession.delete({
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
    return TE.tryCatch(
      async () => {
        const result = await this.dbClient.pkceSession.updateMany({
          where: {
            state: sessionData.state,
            occ: currentOcc
          },
          data: {
            codeVerifier: sessionData.codeVerifier,
            redirectUri: sessionData.redirectUri,
            oidcState: sessionData.oidcState,
            expiresAt: sessionData.expiresAt,
            usedAt: sessionData.usedAt,
            occ: currentOcc + 1n
          }
        })

        if (result.count === 0) {
          throw new Error("PKCE session OCC conflict or not found")
        }
      },
      error => {
        Logger.error("Error updating PKCE session", error)
        if (error instanceof Error && error.message === "PKCE session OCC conflict or not found") {
          return "pkce_code_not_found" as const
        }
        return "pkce_code_storage_failed" as const
      }
    )
  }
}
