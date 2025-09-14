import {generateErrorPayload} from "@controllers/error"
import {createParamDecorator, ExecutionContext, InternalServerErrorException} from "@nestjs/common"
import {AuthenticatedEntity} from "@domain"

/**
 * Parameter decorator to extract the authenticated entity from the request
 *
 * Usage:
 * ```typescript
 * @Controller('api')
 * export class MyController {
 *   @Get('protected')
 *   @UseGuards(JwtAuthGuard)
 *   getProtectedData(@GetAuthenticatedEntity() entity: AuthenticatedEntity) {
 *     // entity contains the authenticated user or agent
 *     if (entity.entityType === 'user') {
 *       return `Hello user ${entity.user.identifier}`
 *     } else {
 *       return `Hello agent ${entity.agent.name}`
 *     }
 *   }
 * }
 * ```
 *
 * How it works:
 * - The JwtStrategy validates JWT tokens and sets `request.requestor` with the authenticated entity
 * - This decorator extracts that entity from `request.requestor` and injects it as a parameter
 * - The entity can be either a user or an agent based on the JWT payload's `entityType`
 *
 * Important: This decorator expects `request.requestor` to be set by the JwtStrategy.
 * Make sure to use `@UseGuards(JwtAuthGuard)` on protected routes.
 */
export const GetAuthenticatedEntity = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthenticatedEntity => {
  const request = ctx.switchToHttp().getRequest()
  // The authenticated entity object is attached to the request by the JwtStrategy as request.requestor
  // This is a custom implementation that deviates from Passport's default behavior of using request.user
  if (!("requestor" in request) || request.requestor === null || request.requestor === undefined)
    throw new InternalServerErrorException(
      generateErrorPayload("entity_undefined", "Unable to identify the requestor.")
    )
  return request.requestor
})
