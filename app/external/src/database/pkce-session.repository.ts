import {Injectable, Logger} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {DatabaseClient} from "./database-client"
import {PkceError, PkceStorageData, PkceSessionData, PkceSessionRepository} from "@services/auth"

@Injectable()
export class PkceSessionDbRepository implements PkceSessionRepository {
  private readonly logger = new Logger(PkceSessionDbRepository.name)

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
            expiresAt: data.expiresAt
          }
        })
      },
      error => {
        this.logger.error("Error storing PKCE data", error)
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

        if (!session) {
          throw new Error("PKCE session not found")
        }

        return {
          state: session.state,
          codeVerifier: session.codeVerifier,
          redirectUri: session.redirectUri,
          oidcState: session.oidcState,
          expiresAt: session.expiresAt
        }
      },
      error => {
        this.logger.error("Error retrieving PKCE data", error)
        return "pkce_code_not_found" as const
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
        this.logger.error("Error deleting PKCE data", error)
        return "pkce_code_storage_failed" as const
      }
    )
  }
}
