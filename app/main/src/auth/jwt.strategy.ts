import {Injectable, Logger, UnauthorizedException} from "@nestjs/common"
import {PassportStrategy} from "@nestjs/passport"
import {ExtractJwt, Strategy} from "passport-jwt"
import {TokenPayloadValidator, UserService} from "@services"
import {User} from "@domain"
import {Versioned} from "@services/shared/utils"
import {generateErrorPayload} from "@controllers/error"
import {isLeft} from "fp-ts/lib/Either"
import {ConfigProvider} from "@external/config"

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  private trustedIssuers: string[]
  private audience: string

  constructor(
    private readonly userService: UserService,
    readonly configProvider: ConfigProvider
  ) {
    const {secret, trustedIssuers, audience} = configProvider.jwtConfig

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
      ignoreExpiration: false
    })

    this.trustedIssuers = trustedIssuers
    this.audience = audience
  }

  async validate(payload: unknown): Promise<Versioned<User>> {
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

    if (payload.entityType === "user") {
      const userResult = await this.userService.getUserByIdentifier(payload.sub)()

      if (isLeft(userResult)) {
        if (userResult.left === "user_not_found")
          throw new UnauthorizedException(generateErrorPayload("USER_NOT_FOUND", "User not found"))
        Logger.error(`Error while fetching the user for token validation: ${userResult.left}`)
        throw new UnauthorizedException(generateErrorPayload("UNKNOWN_ERROR", "An unknown error occurred"))
      }

      return userResult.right
    }

    throw new UnauthorizedException(generateErrorPayload("AGENT_NOT_SUPPORT", "Agent authentication not implemented"))
  }
}
