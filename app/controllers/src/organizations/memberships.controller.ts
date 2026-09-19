import {Membership, MembershipList} from "@approvio/api"
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
  ): Promise<MembershipList> {
    const result = await pipe(
      validateOrganizationPagination(pageValue, limitValue),
      TE.fromEither,
      TE.bindW("memberships", ({page, limit}) => this.memberships.list(context, requestor, page, limit)),
      TE.map(({memberships, page, limit}) => ({
        items: memberships.items.map(({membership}) => mapMembership(membership)),
        total: memberships.total,
        page,
        limit
      }))
    )()

    if (isLeft(result)) throw generateErrorResponseForMembership(result.left)

    return result.right
  }

  @Get(":membershipId")
  @HttpCode(HttpStatus.OK)
  async get(
    @Param("membershipId") membershipId: string,
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Res({passthrough: true}) response: Response
  ): Promise<Membership> {
    const result = await pipe(
      this.memberships.get(context, requestor, membershipId),
      TE.map(membership => this.setETagAndReturnMembership(context, response, membership))
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
  ): Promise<Membership> {
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
  ): Membership {
    response.setHeader("ETag", createEntityTag(this.etagSecret, context.organizationId, membership.id, BigInt(occ)))
    return mapMembership(membership)
  }
}
