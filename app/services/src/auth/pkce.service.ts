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

/**
 * Service for handling PKCE (Proof Key for Code Exchange) operations for OAuth2 authorization code flow.
 *
 * PKCE is a security extension to OAuth 2.0 that prevents authorization code interception attacks.
 * It uses a cryptographically random code verifier and its derived code challenge to secure
 * the authorization flow, especially for public clients.
 *
 * @see https://tools.ietf.org/html/rfc7636
 */
@Injectable()
export class PkceService {
  private readonly PKCE_EXPIRY_MINUTES = 10

  constructor(
    @Inject(PKCE_SESSION_REPOSITORY_TOKEN)
    private readonly pkceSessionRepository: PkceSessionRepository
  ) {}

  /**
   * Generates PKCE challenge data for OAuth2 authorization code flow.
   * Creates cryptographically secure code verifier, code challenge, and state parameters
   * required for PKCE (Proof Key for Code Exchange) security extension.
   */
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

  /**
   * Stores PKCE session data with automatic expiration.
   *
   * This method persists the PKCE data (code verifier, redirect URI, and OIDC state)
   * along with an expiration timestamp. The data is indexed by the provided state parameter
   * for later retrieval during the OAuth callback.
   *
   * @param state - Unique state parameter to identify this PKCE session
   * @param data - PKCE data containing code verifier, redirect URI, and OIDC state
   * @returns TaskEither that resolves to void on success or PkceError on failure
   */
  storePkceData(state: string, data: PkceData): TaskEither<PkceError, void> {
    const expiresAt = new Date(Date.now() + this.PKCE_EXPIRY_MINUTES * 60 * 1000)
    const storageData: PkceStorageData = {
      ...data,
      expiresAt
    }
    return this.pkceSessionRepository.storePkceData(state, storageData)
  }

  /**
   * Retrieves and marks PKCE session data as used in a single atomic operation.
   *
   * This method:
   * 1. Retrieves the PKCE session data by state parameter
   * 2. Validates that the session hasn't expired
   * 3. Marks the session as used (preventing reuse) with optimistic concurrency control
   * 4. Returns the PKCE data needed for token exchange
   *
   * The session is marked as used rather than deleted to maintain an audit trail
   * and prevent race conditions. The optimistic concurrency control ensures that
   * concurrent requests cannot reuse the same PKCE session.
   *
   * @param state - State parameter used to identify the PKCE session
   * @returns TaskEither containing PkceData on success or PkceError on failure
   */
  retrieveAndConsumePkceData(state: string): TaskEither<PkceError, PkceData> {
    const retrieveSession = () => this.pkceSessionRepository.retrievePkceData(state)

    const validateSessionState = (sessionData: PkceSessionData) => {
      if (sessionData.usedAt) {
        Logger.warn(`PKCE session already used for state: ${state}`)
        return TE.left("pkce_code_already_used" as const)
      }

      const now = new Date()
      if (sessionData.expiresAt < now) {
        Logger.warn(`PKCE session expired for state: ${state}`)
        return TE.left("pkce_code_expired" as const)
      }

      return TE.right(sessionData)
    }

    const markSessionAsUsed = (sessionData: PkceSessionData) => {
      const updatedSession = {...sessionData, usedAt: new Date()}
      return pipe(
        this.pkceSessionRepository.updatePkceSession(updatedSession, sessionData.occ),
        TE.mapLeft(error => (error === "pkce_code_not_found" ? ("pkce_code_concurrency_conflict" as const) : error)),
        TE.map(() => sessionData)
      )
    }

    const extractPkceData = (sessionData: PkceSessionData): PkceData => ({
      codeVerifier: sessionData.codeVerifier,
      redirectUri: sessionData.redirectUri,
      oidcState: sessionData.oidcState
    })

    return pipe(
      retrieveSession(),
      TE.chainW(validateSessionState),
      TE.chainW(markSessionAsUsed),
      TE.map(extractPkceData)
    )
  }

  /**
   * Generates a cryptographically secure code verifier for PKCE.
   *
   * @returns Base64url-encoded random string of 32 bytes
   */
  private generateCodeVerifier(): string {
    return randomBytes(32).toString("base64url")
  }

  /**
   * Generates the code challenge from the code verifier using SHA256.
   *
   * The code challenge is derived from the code verifier by hashing it with SHA256
   * and base64url-encoding the result. This allows the authorization server to verify
   * that the client presenting the authorization code is the same one that initiated
   * the authorization request.
   *
   * @param codeVerifier - The code verifier to hash
   * @returns Base64url-encoded SHA256 hash of the code verifier
   */
  private generateCodeChallenge(codeVerifier: string): string {
    return createHash("sha256").update(codeVerifier).digest("base64url")
  }

  /**
   * Generates a cryptographically secure state parameter.
   *
   * The state parameter is used to maintain state between the authorization request
   * and the callback, and to prevent CSRF attacks. It should be unguessable and
   * unique for each authorization request.
   *
   * @returns Base64url-encoded random string of 16 bytes (22 characters)
   */
  private generateState(): string {
    return randomBytes(16).toString("base64url")
  }
}
