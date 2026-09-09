import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException
} from "@nestjs/common"
import {Reflector} from "@nestjs/core"
import {Request} from "express"
import {AuthenticatedEntity, AuthenticatedPlatformSession, createEntityReference, TenantContext} from "@domain"
import {generateErrorPayload} from "@controllers/error"
import {IS_PUBLIC_KEY} from "./jwt.authguard"
import {isUUIDv7} from "@utils"

/**
 * Establishes the request tenant context for organization-scoped routes and, for
 * authenticated requests, verifies that the authenticated principal belongs to it.
 * Public organization-scoped endpoints receive only the route context; their own
 * credential exchange must bind that context to the presented credential.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublicRoute = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])
    const req = ctx
      .switchToHttp()
      .getRequest<Request & {requestor?: AuthenticatedEntity | AuthenticatedPlatformSession; tenantContext?: TenantContext}>()
    const organizationId = req.params?.organizationId

    // TODO: Should we move this in the constructor ?
    // Nest exposes the unprefixed request path only when no global prefix is configured.
    const basePrefix = process.env.BASE_PREFIX ?? ""
    const normalizedPath = basePrefix ? req.path.replace(new RegExp(`^${basePrefix}`), "") : req.path

    if (!normalizedPath.startsWith("/o/")) return true

    if (typeof organizationId !== "string" || !isUUIDv7(organizationId)) {
      Logger.error(`Route '${req.path}' is under /o/ but has an invalid :organizationId route parameter`)
      throw new InternalServerErrorException(generateErrorPayload("UNKNOWN", "An unknown error occurred"))
    }

    req.tenantContext = {organizationId}

    if (isPublicRoute) return true

    if (!req.requestor)
      throw new UnauthorizedException(generateErrorPayload("MISSING_JWT_TOKEN", "Missing authentication token"))

    if (req.requestor.entityType === "platform")
      throw new ForbiddenException(generateErrorPayload("ORGANIZATION_MISMATCH", "Organization access is not authorized"))

    if (createEntityReference(req.requestor).organizationId !== organizationId)
      throw new ForbiddenException(
        generateErrorPayload("ORGANIZATION_MISMATCH", "Organization access is not authorized")
      )

    return true
  }
}
