import {createParamDecorator, ExecutionContext, InternalServerErrorException} from "@nestjs/common"
import {Request} from "express"
import {TenantContext} from "@domain"
import {generateErrorPayload} from "@controllers/error"

export const getTenantContextFactory = (_: unknown, ctx: ExecutionContext): TenantContext => {
  const req = ctx.switchToHttp().getRequest<Request & {tenantContext?: TenantContext}>()
  if (!req.tenantContext)
    throw new InternalServerErrorException(
      generateErrorPayload("tenant_context_undefined", "Tenant context is not available for this request.")
    )

  return req.tenantContext
}

export const GetTenantContext = createParamDecorator(getTenantContextFactory)
