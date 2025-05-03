import {User} from "@domain"
import {createParamDecorator, ExecutionContext} from "@nestjs/common"

export const GetAuthenticatedUser = createParamDecorator((_: unknown, ctx: ExecutionContext): User => {
  const request = ctx.switchToHttp().getRequest()
  // The user object is attached to the request by the JwtStrategy
  return request.user
})
