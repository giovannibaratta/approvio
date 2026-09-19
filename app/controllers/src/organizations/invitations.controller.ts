import {GetAuthenticatedEntity, GetPlatformSession, GetTenantContext, PlatformTenantRoute} from "@app/auth"
import {AuthenticatedEntity, AuthenticatedPlatformSession, TenantContext} from "@domain"
import {InvitationCreated, Membership, validateInvitationAccept, validateInvitationCreate} from "@approvio/api"
import {Body, Controller, Delete, HttpCode, HttpStatus, Param, Post} from "@nestjs/common"
import {InvitationManagementService} from "@services"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {logSuccess} from "@utils"
import {
  generateErrorResponseForInvitation,
  mapAcceptedInvitation,
  mapCreatedInvitation,
  mapInvitationCreateInput
} from "./invitations.mappers"

@Controller("o/:organizationId/invitations")
export class InvitationsController {
  constructor(private readonly invitations: InvitationManagementService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<InvitationCreated> {
    const result = await pipe(
      TE.fromEither(validateInvitationCreate(body)),
      TE.chainEitherKW(invitation => mapInvitationCreateInput({invitation, context, requestor})),
      TE.chainW(request => this.invitations.create(request)),
      TE.chainEitherKW(mapCreatedInvitation),
      logSuccess("Invitation created", "InvitationsController", invitation => ({invitationId: invitation.id}))
    )()

    if (isLeft(result)) throw generateErrorResponseForInvitation(result.left)
    return result.right
  }

  @Delete(":invitationId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param("invitationId") invitationId: string,
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    const result = await pipe(
      this.invitations.revoke(context, requestor, invitationId),
      logSuccess("Invitation revoked", "InvitationsController", () => ({invitationId}))
    )()
    if (isLeft(result)) throw generateErrorResponseForInvitation(result.left)
  }

  @Post(":invitationId/accept")
  @PlatformTenantRoute()
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param("invitationId") invitationId: string,
    @Body() body: unknown,
    @GetTenantContext() context: TenantContext,
    @GetPlatformSession() session: AuthenticatedPlatformSession
  ): Promise<Membership> {
    const result = await pipe(
      TE.fromEither(validateInvitationAccept(body)),
      TE.chainW(({token}) => this.invitations.accept(context, session.account, invitationId, token)),
      TE.chainEitherKW(mapAcceptedInvitation),
      logSuccess("Invitation accepted", "InvitationsController", membership => ({
        invitationId,
        membershipId: membership.id
      }))
    )()

    if (isLeft(result)) throw generateErrorResponseForInvitation(result.left)
    return result.right
  }
}
