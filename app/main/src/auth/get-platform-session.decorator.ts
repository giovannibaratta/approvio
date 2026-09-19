import {generateErrorPayload} from "@controllers/error"
import {createParamDecorator, ExecutionContext, UnauthorizedException} from "@nestjs/common"
import {AuthenticatedBrowserSession, AuthenticatedEntity, AuthenticatedPlatformSession} from "@domain"
import {Request} from "express"

/**
 * Injects the platform session attached to the request by JwtStrategy.
 *
 * Use on routes that operate on an account before it has selected an organization,
 * such as accepting an organization invitation. This only narrows the authenticated
 * request principal; it does not authenticate the request or establish tenant context.
 * A missing principal or any principal other than a platform session is rejected with
 * `INVALID_SESSION`.
 */
export const GetPlatformSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedPlatformSession => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & {requestor?: AuthenticatedEntity | AuthenticatedPlatformSession}>()

    if (!request.requestor || request.requestor.entityType !== "platform")
      throw new UnauthorizedException(generateErrorPayload("INVALID_SESSION", "A platform session is required"))

    return request.requestor
  }
)

/**
 * Injects a browser session attached to the request by JwtStrategy: either a
 * platform session or an authenticated user session. Agent principals are not
 * accepted. Use this when an endpoint supports browser operations both before
 * and after organization selection; use `GetPlatformSession` when it requires
 * the pre-organization platform principal specifically.
 *
 * This decorator does not authenticate the request. Protect the route with the
 * JWT guard so `request.requestor` is populated. Missing or unsupported principals
 * are rejected with `INVALID_SESSION`.
 */
export const GetBrowserSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedBrowserSession => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & {requestor?: AuthenticatedEntity | AuthenticatedPlatformSession}>()

    if (!request.requestor || (request.requestor.entityType !== "platform" && request.requestor.entityType !== "user"))
      throw new UnauthorizedException(generateErrorPayload("INVALID_SESSION", "A browser session is required"))

    return request.requestor
  }
)
