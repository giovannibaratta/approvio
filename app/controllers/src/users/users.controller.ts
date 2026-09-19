import {
  Pagination as PaginationApi,
  UserSummary as UserSummaryApi,
  RoleAssignmentRequest,
  RoleRemovalRequest,
  validateRoleAssignmentRequest,
  validateRoleRemovalRequest
} from "@approvio/api"
import {GetAuthenticatedEntity, GetTenantContext} from "@app/auth"
import {Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Put, Query, Res} from "@nestjs/common"
import {
  ListUsersRequest,
  UserService,
  RoleService,
  AssignRolesToUserRequest,
  RemoveRolesFromUserRequest
} from "@services"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {
  generateErrorResponseForListUsers,
  generateErrorResponseForUserRoleAssignment,
  generateErrorResponseForUserRoleRemoval,
  mapToServiceRequest,
  mapUsersToApi
} from "./users.mappers"
import {AuthenticatedEntity, TenantContext} from "@domain"
import {bindRoleScopeToOrganization} from "../agents/agents.mappers"
import {logSuccess} from "@utils"
import {ConfigProvider} from "@external/config"
import {Response} from "express"
import {createEntityTag, parseEntityTag} from "../etag"

export const USERS_ENDPOINT_ROOT = "o/:organizationId/users"

@Controller(USERS_ENDPOINT_ROOT)
export class UsersController {
  private readonly etagSecret: string

  constructor(
    private readonly userService: UserService,
    private readonly roleService: RoleService,
    configProvider: ConfigProvider
  ) {
    this.etagSecret = configProvider.jwtConfig.secret
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async listUsers(
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Query("search") search?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string
  ): Promise<{users: UserSummaryApi[]; pagination: PaginationApi}> {
    const requestToService = (request: ListUsersRequest) => this.userService.listUsers(request)

    const eitherUsers = await pipe(
      {search, page, limit, organizationId: context.organizationId, requestor},
      mapToServiceRequest,
      TE.fromEither,
      TE.chainW(requestToService),
      TE.map(mapUsersToApi),
      logSuccess("Users listed", "UsersController", result => ({count: result.users.length}))
    )()

    if (isLeft(eitherUsers)) throw generateErrorResponseForListUsers(eitherUsers.left, "Failed to list users")

    return eitherUsers.right
  }

  @Put(":userId/roles")
  @HttpCode(HttpStatus.NO_CONTENT)
  async assignRolesToUser(
    @Param("userId") userId: string,
    @Body() request: unknown,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @GetTenantContext() context: TenantContext,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({passthrough: true}) response: Response
  ): Promise<void> {
    const mapToServiceModel = (req: RoleAssignmentRequest, occVersion: bigint) => ({
      userId,
      roles: req.roles.map(role => ({...role, scope: bindRoleScopeToOrganization(role.scope, context.organizationId)})),
      requestor,
      context,
      occVersion
    })
    const assignRole = (req: AssignRolesToUserRequest) => this.roleService.assignRolesToUser(req)

    const eitherResult = await pipe(
      TE.Do,
      TE.bindW("occVersion", () =>
        TE.fromEither(parseEntityTag(this.etagSecret, context.organizationId, userId, ifMatch))
      ),
      TE.bindW("validatedRequest", () => TE.fromEither(validateRoleAssignmentRequest(request))),
      TE.bindW("serviceRequest", ({validatedRequest, occVersion}) =>
        TE.right(mapToServiceModel(validatedRequest, occVersion))
      ),
      TE.bindW("updatedResult", ({serviceRequest}) => assignRole(serviceRequest)),
      logSuccess("Roles assigned to user", "UsersController", () => ({userId}))
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForUserRoleAssignment(eitherResult.left, "Failed to assign roles to user")
    response.setHeader(
      "ETag",
      createEntityTag(this.etagSecret, context.organizationId, userId, eitherResult.right.updatedResult.updatedOcc)
    )
  }

  @Delete(":userId/roles")
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeRolesFromUser(
    @Param("userId") userId: string,
    @Body() request: unknown,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @GetTenantContext() context: TenantContext,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({passthrough: true}) response: Response
  ): Promise<void> {
    const mapToServiceModel = (req: RoleRemovalRequest, occVersion: bigint) => ({
      userId,
      roles: req.roles.map(role => ({...role, scope: bindRoleScopeToOrganization(role.scope, context.organizationId)})),
      requestor,
      context,
      occVersion
    })
    const removeRole = (req: RemoveRolesFromUserRequest) => this.roleService.removeRolesFromUser(req)

    const eitherResult = await pipe(
      TE.Do,
      TE.bindW("occVersion", () =>
        TE.fromEither(parseEntityTag(this.etagSecret, context.organizationId, userId, ifMatch))
      ),
      TE.bindW("validatedRequest", () => TE.fromEither(validateRoleRemovalRequest(request))),
      TE.bindW("serviceRequest", ({validatedRequest, occVersion}) =>
        TE.right(mapToServiceModel(validatedRequest, occVersion))
      ),
      TE.bindW("updatedResult", ({serviceRequest}) => removeRole(serviceRequest)),
      logSuccess("Roles removed from user", "UsersController", () => ({userId}))
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForUserRoleRemoval(eitherResult.left, "Failed to remove roles from user")
    response.setHeader(
      "ETag",
      createEntityTag(this.etagSecret, context.organizationId, userId, eitherResult.right.updatedResult.updatedOcc)
    )
  }
}
