import {ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException} from "@nestjs/common"
import {Request} from "express"
import {PassportStrategy} from "@nestjs/passport"
import {ExtractJwt, Strategy} from "passport-jwt"
import {
  AgentTokenPayload,
  JwtPrincipalService,
  PlatformTokenPayload,
  TokenPayloadValidator,
  UserTokenPayload
} from "@services"
import {generateErrorPayload} from "@controllers/error"
import {isRight} from "fp-ts/Either"
import {ConfigProvider} from "@external/config"
import {
  AuthenticatedEntity,
  AuthenticatedPlatformSession,
  StepUpContext,
  isStepUpOperation,
  AuthenticatedAgent
} from "@domain"

/**
 * JWT Authentication Strategy for NestJS using Passport
 *
 * This strategy validates JWT tokens and attaches the authenticated entity (user or agent)
 * to the request object as `request.requestor` instead of the default `request.user`.
 *
 * Custom behavior:
 * - Uses `passReqToCallback: true` to access the request object in validate()
 * - Manually sets `request.requestor` with the authenticated entity
 * - This allows the GetAuthenticatedEntity decorator to access `request.requestor`
 *
 * The authenticated entity can be either a user or an agent based on the JWT payload.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  private trustedIssuers: string[]
  private audience: string

  constructor(
    private readonly jwtPrincipalService: JwtPrincipalService,
    readonly configProvider: ConfigProvider
  ) {
    const {secret, trustedIssuers, audience} = configProvider.jwtConfig

    super({
      jwtFromRequest: (req: Request) => {
        // Try HttpOnly cookie first (browser clients)
        const reqWithCookies = req as Omit<Request, "cookies"> & {cookies?: Record<string, unknown>}
        const cookieToken = reqWithCookies.cookies?.access_token
        if (typeof cookieToken === "string") return cookieToken

        // Fallback to Authorization header (CLI, agents)
        return ExtractJwt.fromAuthHeaderAsBearerToken()(req)
      },
      secretOrKey: secret,
      ignoreExpiration: false,
      // Enable request access in validate() to manually set request.requestor
      passReqToCallback: true
    })

    this.trustedIssuers = trustedIssuers
    this.audience = audience
  }

  /**
   * Validates and retrieves a user entity by identifier
   *
   * @param userIdentifier - User identifier from JWT payload
   * @returns Promise<AuthenticatedUser> - User entity wrapped in AuthenticatedEntity
   * @throws UnauthorizedException - When user is not found or other errors occur
   */
  private async validateUserEntity(payload: UserTokenPayload) {
    const result = await this.jwtPrincipalService.resolveUser(payload)()
    if (isRight(result)) return result.right
    if (result.left === "account_not_found")
      throw new UnauthorizedException(generateErrorPayload("ACCOUNT_NOT_FOUND", "Account not found"))
    if (result.left === "resource_not_found")
      throw new NotFoundException(generateErrorPayload("USER_NOT_FOUND", "User not found"))
    if (result.left === "organization_context_changed")
      throw new ConflictException(generateErrorPayload("ORGANIZATION_CONTEXT_CHANGED", "Organization context changed"))
    if (
      result.left === "invalid_session" ||
      result.left === "invalid_credential" ||
      result.left === "invalid_organization_id"
    )
      throw new UnauthorizedException(generateErrorPayload("INVALID_SESSION", "Session is no longer active"))

    Logger.error(`Error while fetching the user for token validation: ${result.left}`)
    throw new UnauthorizedException(generateErrorPayload("UNKNOWN_ERROR", "An unknown error occurred"))
  }

  /**
   * Validates and retrieves an agent entity by immutable identifier within its organization.
   *
   * @param agentId - Agent identifier from JWT payload
   * @param organizationId - Organization identifier from JWT payload
   * @returns Promise<AuthenticatedAgent> - Agent entity wrapped in AuthenticatedEntity
   * @throws UnauthorizedException - When agent is not found or other errors occur
   */
  private async validateAgentEntity(payload: AgentTokenPayload): Promise<AuthenticatedAgent> {
    const agentResult = await this.jwtPrincipalService.resolveAgent(payload)()
    if (isRight(agentResult)) return agentResult.right

    if (agentResult.left === "agent_not_found")
      throw new UnauthorizedException(generateErrorPayload("AGENT_NOT_FOUND", "Agent not found"))
    if (agentResult.left === "agent_revoked")
      throw new UnauthorizedException(generateErrorPayload("AGENT_REVOKED", "Agent is revoked"))

    Logger.error(`Error while fetching the agent for token validation: ${agentResult.left}`)
    throw new UnauthorizedException(generateErrorPayload("UNKNOWN_ERROR", "An unknown error occurred"))
  }

  private async validatePlatformSession(payload: PlatformTokenPayload): Promise<AuthenticatedPlatformSession> {
    const result = await this.jwtPrincipalService.resolvePlatformSession(payload)()
    if (isRight(result)) return result.right
    if (result.left === "account_not_found")
      throw new UnauthorizedException(generateErrorPayload("ACCOUNT_NOT_FOUND", "Account not found"))
    if (result.left === "invalid_session" || result.left === "invalid_credential")
      throw new UnauthorizedException(generateErrorPayload("INVALID_SESSION", "Session is no longer active"))

    Logger.error(`Error while fetching platform session for token validation: ${result.left}`)
    throw new UnauthorizedException(generateErrorPayload("UNKNOWN_ERROR", "An unknown error occurred"))
  }

  /**
   * Validates JWT payload and sets the authenticated entity on the request
   *
   * @param req - Express request object (extended to include requestor property)
   * @param payload - JWT payload after signature verification
   * @returns AuthenticatedEntity (user or agent)
   *
   * Note: This method manually sets `req.requestor` to make the authenticated entity
   * available to the GetAuthenticatedEntity decorator. This is a custom behavior
   * that deviates from Passport's default of setting `req.user`.
   */
  async validate(
    req: Request & {requestor?: AuthenticatedEntity | AuthenticatedPlatformSession},
    payload: unknown
  ): Promise<AuthenticatedEntity | AuthenticatedPlatformSession> {
    // This method is invoked after Passport has verified the JWT's signature
    if (!TokenPayloadValidator.isValidPayloadSchema(payload))
      throw new UnauthorizedException(
        generateErrorPayload("INVALID_JWT_TOKEN_FORMAT", "Invalid token payload structure")
      )

    if (!TokenPayloadValidator.isValidTime(payload))
      throw new UnauthorizedException(
        generateErrorPayload("JWT_TOKEN_EXPIRED_OR_NOT_YET_VALID", "Token has expired or is not yet valid")
      )

    if (!TokenPayloadValidator.isValidIssuer(payload, this.trustedIssuers))
      throw new UnauthorizedException(generateErrorPayload("INVALID_ISSUER", "Invalid token issuer"))

    if (!TokenPayloadValidator.isValidAudience(payload, this.audience))
      throw new UnauthorizedException(generateErrorPayload("INVALID_AUDIENCE", "Invalid token audience"))

    let authenticatedEntity: AuthenticatedEntity | AuthenticatedPlatformSession

    if (payload.entityType === "user") {
      authenticatedEntity = await this.validateUserEntity(payload)

      if (payload.jti && payload.operation) {
        if (!isStepUpOperation(payload.operation))
          throw new UnauthorizedException(
            generateErrorPayload("INVALID_STEP_UP_OPERATION", "Unknown step-up operation in token")
          )

        const stepUpContext: StepUpContext = {
          jti: payload.jti,
          operation: payload.operation,
          ...(payload.resource ? {resource: payload.resource} : {})
        }

        authenticatedEntity = {
          ...authenticatedEntity,
          authContext: stepUpContext
        }
      }
    } else if (payload.entityType === "agent") authenticatedEntity = await this.validateAgentEntity(payload)
    else if (payload.entityType === "platform") authenticatedEntity = await this.validatePlatformSession(payload)
    else throw new UnauthorizedException(generateErrorPayload("INVALID_ENTITY_TYPE", "Invalid entity type in token"))

    // Set requestor on request for GetAuthenticatedEntity decorator
    req.requestor = authenticatedEntity
    return authenticatedEntity
  }
}
