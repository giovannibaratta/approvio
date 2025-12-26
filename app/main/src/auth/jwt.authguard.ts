import {
  BadRequestException,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  SetMetadata,
  UnauthorizedException
} from "@nestjs/common"
import {Reflector} from "@nestjs/core"
import {AuthGuard} from "@nestjs/passport"
import {isJsonWebTokenError, isTokenExpiredError} from "./utils"
import {generateErrorPayload} from "@controllers/error"

export const IS_PUBLIC_KEY = "isPublic"
/** Identify route that don't need authentication */
export const PublicRoute = () => SetMetadata(IS_PUBLIC_KEY, true)

// Source https://docs.nestjs.com/recipes/passport

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private reflector: Reflector) {
    super()
  }

  canActivate(context: ExecutionContext) {
    const isPublicRoute = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ])
    // If a route is tagged as Public, there should be no need for a JWT token.
    // All the validation should be skipped.
    if (isPublicRoute) return true
    return super.canActivate(context)
  }

  handleRequest<TUser>(
    err: unknown,
    user: unknown,
    info: unknown,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _status?: unknown
  ): TUser {
    if (info) {
      if (isTokenExpiredError(info))
        throw new UnauthorizedException(generateErrorPayload("JWT_TOKEN_EXPIRED", "Authentication token has expired."))

      if (isJsonWebTokenError(info)) {
        const msg = info.message

        if (msg.includes("jwt malformed"))
          throw new BadRequestException(generateErrorPayload("JWT_TOKEN_MALFORMED", msg))

        if (msg.includes("invalid signature"))
          throw new UnauthorizedException(generateErrorPayload("JWT_TOKEN_INVALID", msg))

        throw new UnauthorizedException(generateErrorPayload("JWT_TOKEN_INVALID", msg))
      }
    }

    if (err) {
      Logger.error("Unable to validate JWT token")
      Logger.error(err)
      throw new InternalServerErrorException(generateErrorPayload("JWT_UNKNOWN_ERROR", "Unable to validate JWT token"))
    }

    if (!user)
      throw new UnauthorizedException(generateErrorPayload("MISSING_JWT_TOKEN", "Missing authentication token"))

    return user as TUser
  }
}
