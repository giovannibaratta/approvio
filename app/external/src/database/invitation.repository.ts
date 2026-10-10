import {Injectable} from "@nestjs/common"
import {Invitation, InvitationFactory, MutationError, OrgRole, TenantContext, Versioned} from "@domain"
import {getStringAsEnum} from "@utils"
import {InvitationRepository, RepositoryDependencyError} from "@services"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {InvitationTenantClient} from "./tenant-database-clients"
import {OrganizationInvitation} from "@prisma/client"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"

@Injectable()
export class InvitationDbRepository implements InvitationRepository {
  constructor(private readonly dbClient: InvitationTenantClient) {}

  create(
    context: TenantContext,
    invitation: Invitation
  ): TE.TaskEither<MutationError | RepositoryDependencyError, void> {
    return TE.tryCatch(
      async () => {
        if (context.organizationId !== invitation.organizationId) throw new InvitationNotFoundError()
        await this.dbClient.cx.organizationInvitation.create({
          data: {
            id: invitation.id,
            organizationId: context.organizationId,
            targetAccountId: invitation.inviteeAccountId,
            inviterUserId: invitation.inviterUserId,
            tokenHash: invitation.tokenHash,
            requestedOrgRole: invitation.orgRole,
            expiresAt: invitation.expiresAt,
            acceptedAt: null,
            revokedAt: null,
            createdAt: new Date(),
            occ: 0n
          }
        })
      },
      error => this.mapError(error)
    )
  }

  getById(
    context: TenantContext,
    invitationId: string
  ): TE.TaskEither<MutationError | RepositoryDependencyError, Versioned<Invitation>> {
    return TE.tryCatch(
      async () => {
        const row = await this.dbClient.cx.organizationInvitation.findUnique({
          where: {organizationId_id: {organizationId: context.organizationId, id: invitationId}}
        })
        if (!row) throw new InvitationNotFoundError()
        return {...mapInvitation(row), occ: row.occ}
      },
      error => this.mapError(error)
    )
  }

  persist(
    context: TenantContext,
    invitation: Invitation,
    expectedOcc: bigint
  ): TE.TaskEither<MutationError | RepositoryDependencyError, void> {
    return TE.tryCatch(
      async () => {
        await this.dbClient.cx.organizationInvitation.update({
          where: {
            organizationId_id: {organizationId: context.organizationId, id: invitation.id},
            AND: {organizationId: invitation.organizationId},
            occ: expectedOcc,
            acceptedAt: null,
            revokedAt: null
          },
          data: {
            acceptedAt: invitation.status === "accepted" ? invitation.acceptedAt : null,
            revokedAt: invitation.status === "revoked" ? invitation.revokedAt : null,
            occ: {increment: 1}
          }
        })
      },
      error =>
        isPrismaRecordNotFoundError(error, "OrganizationInvitation")
          ? "concurrent_modification_error"
          : this.mapError(error)
    )
  }

  private mapError(error: unknown): MutationError | RepositoryDependencyError {
    if (error instanceof InvitationNotFoundError) return "resource_not_found"
    if (isPrismaUniqueConstraintError(error, ["token_hash"])) return "resource_already_exists"
    // The transaction boundary owns infrastructure failures and serialization retries.
    throw error
  }
}

function mapInvitation(row: OrganizationInvitation): Invitation {
  const orgRole = getStringAsEnum(row.requestedOrgRole, OrgRole)
  if (orgRole === undefined) throw new Error("Invalid invitation role")
  const status = row.acceptedAt ? "accepted" : row.revokedAt ? "revoked" : "pending"
  const invitationData = {
    id: row.id,
    organizationId: row.organizationId,
    inviteeAccountId: row.targetAccountId,
    inviterUserId: row.inviterUserId,
    tokenHash: row.tokenHash,
    orgRole,
    expiresAt: row.expiresAt,
    status,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt
  }
  const validated = InvitationFactory.validate(invitationData)
  if (E.isLeft(validated)) throw new Error("Invalid invitation record")
  return validated.right
}

class InvitationNotFoundError extends Error {}
