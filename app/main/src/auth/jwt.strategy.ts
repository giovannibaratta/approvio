import {Injectable, Logger, UnauthorizedException} from "@nestjs/common"
import {Request} from "express"
import {PassportStrategy} from "@nestjs/passport"
import {ExtractJwt, Strategy} from "passport-jwt"
import {TokenPayloadValidator, UserService, AgentService, AuthenticatedEntity} from "@services"
import {generateErrorPayload} from "@controllers/error"
import {isRight} from "fp-ts/lib/Either"
import {ConfigProvider} from "@external/config"

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
    private readonly userService: UserService,
    private readonly agentService: AgentService,
    readonly configProvider: ConfigProvider
  ) {
    const {secret, trustedIssuers, audience} = configProvider.jwtConfig

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
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
   * @returns Promise<AuthenticatedEntity> - User entity wrapped in AuthenticatedEntity
   * @throws UnauthorizedException - When user is not found or other errors occur
   */
  private async validateUserEntity(userIdentifier: string): Promise<AuthenticatedEntity> {
    const userResult = await this.userService.getUserByIdentifier(userIdentifier)()

    if (isRight(userResult)) {
      return {
        entityType: "user",
        user: userResult.right
      } as AuthenticatedEntity
    }

    if (userResult.left === "user_not_found")
      throw new UnauthorizedException(generateErrorPayload("USER_NOT_FOUND", "User not found"))

    Logger.error(`Error while fetching the user for token validation: ${userResult.left}`)
    throw new UnauthorizedException(generateErrorPayload("UNKNOWN_ERROR", "An unknown error occurred"))
  }

  /**
   * Validates and retrieves an agent entity by name
   *
   * @param agentName - Agent name from JWT payload
   * @returns Promise<AuthenticatedEntity> - Agent entity wrapped in AuthenticatedEntity
   * @throws UnauthorizedException - When agent is not found or other errors occur
   */
  private async validateAgentEntity(agentName: string): Promise<AuthenticatedEntity> {
    const agentResult = await this.agentService.getAgentByName(agentName)()

    if (isRight(agentResult)) {
      return {
        entityType: "agent",
        agent: agentResult.right
      } as AuthenticatedEntity
    }

    if (agentResult.left === "agent_not_found")
      throw new UnauthorizedException(generateErrorPayload("AGENT_NOT_FOUND", "Agent not found"))

    Logger.error(`Error while fetching the agent for token validation: ${agentResult.left}`)
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
  async validate(req: Request & {requestor?: AuthenticatedEntity}, payload: unknown): Promise<AuthenticatedEntity> {
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

    let authenticatedEntity: AuthenticatedEntity

    if (payload.entityType === "user") authenticatedEntity = await this.validateUserEntity(payload.sub)
    else if (payload.entityType === "agent") authenticatedEntity = await this.validateAgentEntity(payload.sub)
    else throw new UnauthorizedException(generateErrorPayload("INVALID_ENTITY_TYPE", "Invalid entity type in token"))

    // Set requestor on request for GetAuthenticatedEntity decorator
    req.requestor = authenticatedEntity
    return authenticatedEntity
  }
}
