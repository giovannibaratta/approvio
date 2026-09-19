import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  SetMetadata,
  UnauthorizedException
} from "@nestjs/common"
import {Reflector} from "@nestjs/core"
import {Request} from "express"
import {
  AuthenticatedEntity,
  AuthenticatedPlatformSession,
  createEntityReference,
  isOrganizationId,
  TenantContext
} from "@domain"
import {generateErrorPayload} from "@controllers/error"
import {mapOrganizationAdmissionError} from "./organization-admission-error.mapper"
import {OrganizationAdmissionService} from "@services/tenancy/organization-admission.service"
import type {OrganizationAdmissionOperation} from "@services/tenancy/organization-admission.service"
import {isRight} from "fp-ts/Either"
import {IS_PUBLIC_KEY} from "./jwt.authguard"

const PLATFORM_TENANT_ROUTE = "platformTenantRoute"
const ORGANIZATION_ADMISSION_OPERATION = "organizationAdmissionOperation"

/** Declares a controller's admission policy or overrides it for an individual endpoint. */
export const OrganizationAdmission = (operation: OrganizationAdmissionOperation) =>
  SetMetadata(ORGANIZATION_ADMISSION_OPERATION, operation)

/**
 * Marks an organization-scoped route that may be called with a platform session.
 * This is an exception to the usual rule that a tenant user or agent must belong to the
 * organization in `:organizationId`. An invitee without membership is authenticated
 * as a platform principal, not as a tenant user, so this marker lets that session reach the
 * invitation handler.
 */
export const PlatformTenantRoute = () => SetMetadata(PLATFORM_TENANT_ROUTE, true)

/**
 * Establishes tenant context, checks route organization scope, then applies the
 * organization's current lifecycle rules for authenticated tenant requests.
 * Public organization-scoped endpoints receive only the route context; their own
 * credential exchange must bind that context to the presented credential.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(OrganizationAdmissionService)
    private readonly admission: OrganizationAdmissionService
  ) {}

  canActivate(ctx: ExecutionContext): boolean | Promise<boolean> {
    const isPublicRoute = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass()
    ])
    // A method marker overrides controller metadata; only platform principals use this exception.
    const acceptsPlatformSession = this.reflector.getAllAndOverride<boolean | undefined>(PLATFORM_TENANT_ROUTE, [
      ctx.getHandler(),
      ctx.getClass()
    ])

    const operation = this.reflector.getAllAndOverride<OrganizationAdmissionOperation | undefined>(
      ORGANIZATION_ADMISSION_OPERATION,
      [ctx.getHandler(), ctx.getClass()]
    )

    const req = ctx
      .switchToHttp()
      .getRequest<
        Request & {requestor?: AuthenticatedEntity | AuthenticatedPlatformSession; tenantContext?: TenantContext}
      >()
    const organizationId = req.params?.organizationId

    // Not a tenant-scoped endpoint.
    if (organizationId === undefined) return true

    if (!isOrganizationId(organizationId)) {
      Logger.error(`Route '${req.path}' has an invalid :organizationId route parameter`)
      throw new BadRequestException(generateErrorPayload("INVALID_ORGANIZATION", "Invalid organization"))
    }

    const tenantContext = {organizationId}
    req.tenantContext = tenantContext

    if (isPublicRoute) return true

    if (!req.requestor)
      throw new UnauthorizedException(generateErrorPayload("MISSING_JWT_TOKEN", "Missing authentication token"))

    // Platform sessions have no organization membership to compare. Only an explicitly marked
    // route may use the URL's organization as its target; JwtAuthGuard still authenticates it.
    if (req.requestor.entityType === "platform" && acceptsPlatformSession) return true

    // All other platform sessions are denied, and tenant principals must match the URL exactly.
    if (req.requestor.entityType === "platform")
      throw new ForbiddenException(
        generateErrorPayload("ORGANIZATION_MISMATCH", "Organization access is not authorized")
      )

    if (createEntityReference(req.requestor).organizationId !== organizationId)
      throw new ForbiddenException(
        generateErrorPayload("ORGANIZATION_MISMATCH", "Organization access is not authorized")
      )

    if (operation === undefined) {
      Logger.error(`Route '${req.path}' has no organization admission policy`, "TenantGuard")
      throw new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Internal server error"))
    }

    return this.applyAdmission(tenantContext, req.requestor, operation)
  }

  private async applyAdmission(
    context: TenantContext,
    requestor: AuthenticatedEntity,
    operation: OrganizationAdmissionOperation
  ): Promise<boolean> {
    const result = await this.admission.admit(context, requestor, operation)()

    if (isRight(result)) return true

    throw mapOrganizationAdmissionError(result.left)
  }
}
