import {Injectable, Inject, Logger} from "@nestjs/common"
import {createHash, randomBytes} from "crypto"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {
  PKCE_SESSION_REPOSITORY_TOKEN,
  PkceChallenge,
  PkceData,
  PkceError,
  PkceSessionRepository,
  PkceStorageData,
  PkceSessionData
} from "./interfaces"

@Injectable()
export class PkceService {
  private readonly logger = new Logger(PkceService.name)
  private readonly PKCE_EXPIRY_MINUTES = 10

  constructor(
    @Inject(PKCE_SESSION_REPOSITORY_TOKEN)
    private readonly pkceSessionRepository: PkceSessionRepository
  ) {}

  generatePkceChallenge(): TaskEither<PkceError, PkceChallenge> {
    const codeVerifier = this.generateCodeVerifier()
    const codeChallenge = this.generateCodeChallenge(codeVerifier)
    const state = this.generateState()

    return TE.right({
      codeVerifier,
      codeChallenge,
      state
    })
  }

  storePkceData(state: string, data: PkceData): TaskEither<PkceError, void> {
    const expiresAt = new Date(Date.now() + this.PKCE_EXPIRY_MINUTES * 60 * 1000)
    const storageData: PkceStorageData = {
      ...data,
      expiresAt
    }
    return this.pkceSessionRepository.storePkceData(state, storageData)
  }

  retrievePkceDataByState(state: string): TaskEither<PkceError, PkceSessionData> {
    const retrieveSession = () => this.pkceSessionRepository.retrievePkceData(state)

    const validateExpiration = (sessionData: PkceSessionData) => {
      const now = new Date()
      if (sessionData.expiresAt < now) {
        this.logger.warn(`PKCE session expired for state: ${state}`)
        return pipe(
          this.pkceSessionRepository.deletePkceData(state),
          TE.chainW(() => TE.left("pkce_code_expired" as const))
        )
      }
      return TE.right(sessionData)
    }

    return pipe(retrieveSession(), TE.chainW(validateExpiration))
  }

  retrieveAndConsumePkceData(state: string): TaskEither<PkceError, PkceData> {
    const retrieveSession = () => this.pkceSessionRepository.retrievePkceData(state)

    const validateExpiration = (sessionData: PkceSessionData) => {
      const now = new Date()
      if (sessionData.expiresAt < now) {
        this.logger.warn(`PKCE session expired for state: ${state}`)
        return pipe(
          this.pkceSessionRepository.deletePkceData(state),
          TE.chainW(() => TE.left("pkce_code_expired" as const))
        )
      }
      return TE.right(sessionData)
    }

    const deleteSessionAndReturnData = (sessionData: PkceSessionData) => {
      return pipe(
        this.pkceSessionRepository.deletePkceData(state),
        TE.map(
          (): PkceData => ({
            codeVerifier: sessionData.codeVerifier,
            redirectUri: sessionData.redirectUri,
            oidcState: sessionData.oidcState
          })
        )
      )
    }

    return pipe(retrieveSession(), TE.chainW(validateExpiration), TE.chainW(deleteSessionAndReturnData))
  }

  verifyAndRetrievePkceData(state: string, codeVerifier: string): TaskEither<PkceError, PkceData> {
    const retrieveSession = () => this.pkceSessionRepository.retrievePkceData(state)

    const validateExpiration = (sessionData: PkceSessionData) => {
      const now = new Date()
      if (sessionData.expiresAt < now) {
        this.logger.warn(`PKCE session expired for state: ${state}`)
        return pipe(
          this.pkceSessionRepository.deletePkceData(state),
          TE.chainW(() => TE.left("pkce_code_expired" as const))
        )
      }
      return TE.right(sessionData)
    }

    const validateCodeVerifier = (sessionData: PkceSessionData) => {
      if (sessionData.codeVerifier !== codeVerifier) {
        this.logger.warn("PKCE code verifier mismatch")
        return TE.left("pkce_code_verification_failed" as const)
      }
      return TE.right(sessionData)
    }

    const deleteSessionAndReturnData = (sessionData: PkceSessionData) => {
      return pipe(
        this.pkceSessionRepository.deletePkceData(state),
        TE.map(
          (): PkceData => ({
            codeVerifier: sessionData.codeVerifier,
            redirectUri: sessionData.redirectUri,
            oidcState: sessionData.oidcState
          })
        )
      )
    }

    return pipe(
      retrieveSession(),
      TE.chainW(validateExpiration),
      TE.chainW(validateCodeVerifier),
      TE.chainW(deleteSessionAndReturnData)
    )
  }

  private generateCodeVerifier(): string {
    return randomBytes(32).toString("base64url")
  }

  private generateCodeChallenge(codeVerifier: string): string {
    return createHash("sha256").update(codeVerifier).digest("base64url")
  }

  private generateState(): string {
    return randomBytes(16).toString("base64url")
  }
}
