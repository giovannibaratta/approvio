import {GetAuthenticatedEntity, GetTenantContext} from "@app/auth"
import {AuthenticatedEntity, TenantContext} from "@domain"
import {ConfigProvider} from "@external/config"
import {Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Patch, Query, Res} from "@nestjs/common"
import {MembershipManagementService, VersionedMembership} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {createEntityTag, parseEntityTag} from "../etag"
import {validateOrganizationPagination} from "./organization.mappers"
import {generateErrorResponseForMembership, mapMembership, validateMembershipRole} from "./memberships.mappers"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"

@Controller("o/:organizationId/members")
export class MembershipsController {
  private readonly etagSecret: string

  constructor(
    private readonly memberships: MembershipManagementService,
    config: ConfigProvider
  ) {
    this.etagSecret = config.jwtConfig.secret
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Query("page") pageValue?: string,
    @Query("limit") limitValue?: string
    // TODO: Why this return type, don't we have an approvio api model ?
  ): Promise<{items: ReadonlyArray<Record<string, unknown>>; total: number; page: number; limit: number}> {
    const result = await pipe(
      validateOrganizationPagination(pageValue, limitValue),
      TE.fromEither,
      TE.bindW("memberships", ({page, limit}) => this.memberships.list(context, requestor, page, limit)),
      TE.map(({memberships, page, limit}) => ({
        items: memberships.items.map(({membership, occ}) => ({
          ...mapMembership(membership),
          // TODO: USually we return the etag in teh headers, but this is a list endpoint, maybe we should just not return it an dupdate the APIs 
          etag: createEntityTag(this.etagSecret, context.organizationId, membership.id, BigInt(occ))
        })),
        total: memberships.total,
        page,
        limit
      }))
    )()

    if (isLeft(result)) throw generateErrorResponseForMembership(result.left)

    return result.right
  }

  @Patch(":membershipId")
  @HttpCode(HttpStatus.OK)
  async changeRole(
    @Param("membershipId") membershipId: string,
    @Body() body: unknown,
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({passthrough: true}) response: Response
    // TODO: Why the reutnr type is string unknown, don't we have an approvio api model ?
  ): Promise<Record<string, unknown>> {
    const result = await pipe(
      validateMembershipRole(body),
      TE.fromEither,
      TE.bindTo("orgRole"),
      TE.bindW("version", () =>
        TE.fromEither(parseEntityTag(this.etagSecret, context.organizationId, membershipId, ifMatch))
      ),
      TE.chainW(({orgRole, version}) =>
        this.memberships.changeRole(context, requestor, {
          membershipId,
          orgRole,
          // TODO: Are we using teh name nomeclature used in the other controllers ?
          expectedVersion: version.toString()
        })
      ),
      // TODO: it is correct that this is a mpa ?
      TE.map(membership => this.setETagAndReturnMembership(context, response, membership))
    )()

    if (isLeft(result)) throw generateErrorResponseForMembership(result.left)

    return result.right
  }

  @Delete(":membershipId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("membershipId") membershipId: string,
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Headers("if-match") ifMatch: string | undefined
  ): Promise<void> {
    const result = await pipe(
      parseEntityTag(this.etagSecret, context.organizationId, membershipId, ifMatch),
      TE.fromEither,
      TE.chainW(version =>
        this.memberships.remove(context, requestor, {
          membershipId,
          // TODO: Why a string ?
          expectedVersion: version.toString()
        })
      )
    )()

    if (isLeft(result)) throw generateErrorResponseForMembership(result.left)
  }

  private setETagAndReturnMembership(
    context: TenantContext,
    response: Response,
    {membership, occ}: VersionedMembership
    // TODO: Why the reutnr type is string unknown, don't we have an approvio api model ?
  ): Record<string, unknown> {
    response.setHeader("ETag", createEntityTag(this.etagSecret, context.organizationId, membership.id, BigInt(occ)))
    return mapMembership(membership)
  }
}
