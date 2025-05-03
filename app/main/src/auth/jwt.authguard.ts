import {ExecutionContext, Injectable, SetMetadata} from "@nestjs/common"
import {Reflector} from "@nestjs/core"
import {AuthGuard} from "@nestjs/passport"

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
}
