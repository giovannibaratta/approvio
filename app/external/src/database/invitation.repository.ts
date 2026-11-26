import {fromPromise} from "./repository-operation"
import {pipe} from "fp-ts/function"
import {chainNullableToLeft} from "./utils"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {Injectable} from "@nestjs/common"
import {
  Invitation,
  InvitationFactory,
  InvitationValidationError,
  MutationError,
  TenantContext,
  Versioned
} from "@domain"
import {InvitationRepository, RepositoryDependencyError} from "@services"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {InvitationTenantClient} from "./tenant-database-clients"
import {OrganizationInvitation, Prisma} from "@prisma/client"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"

@Injectable()
export class InvitationDbRepository implements InvitationRepository {
  constructor(private readonly dbClient: InvitationTenantClient) {}

  hasPending(context: TenantContext, accountId: string, at: Date): TE.TaskEither<RepositoryDependencyError, boolean> {
    return fromPromise(
      async () => {
        this.dbClient.assertIsolationLevel(Prisma.TransactionIsolationLevel.Serializable)
        const pending = await this.dbClient.cx.organizationInvitation.findFirst({
          where: {
            organizationId: context.organizationId,
            targetAccountId: accountId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: {gt: at}
          },
          select: {id: true}
        })
        return pending !== null
      },
      () => "repository_dependency_error" as const
    )
  }

  create(invitation: Invitation): TE.TaskEither<MutationError | RepositoryDependencyError, void> {
    return fromPromise(
      async () => {
        await this.dbClient.cx.organizationInvitation.create({
          data: {
            id: invitation.id,
            organizationId: invitation.organizationId,
            targetAccountId: invitation.inviteeAccountId,
            inviterUserId: invitation.inviterUserId,
            tokenHash: invitation.tokenHash,
            requestedOrgRole: invitation.orgRole,
            expiresAt: invitation.expiresAt,
            acceptedAt: invitation.status === "accepted" ? invitation.acceptedAt : null,
            revokedAt: invitation.status === "revoked" ? invitation.revokedAt : null,
            createdAt: invitation.createdAt,
            occ: POSTGRES_BIGINT_LOWER_BOUND
          }
        })
      },
      error => this.mapError(error)
    )
  }

  getById(
    context: TenantContext,
    invitationId: string
  ): TE.TaskEither<MutationError | InvitationValidationError | RepositoryDependencyError, Versioned<Invitation>> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.organizationInvitation.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: invitationId}}
          }),
        error => this.mapError(error)
      ),
      chainNullableToLeft("resource_not_found" as const),
      TE.chainEitherKW(row => E.map((invitation: Invitation) => ({...invitation, occ: row.occ}))(mapInvitation(row)))
    )
  }

  persist(
    context: TenantContext,
    invitation: Invitation,
    expectedOcc: bigint
  ): TE.TaskEither<MutationError | RepositoryDependencyError, void> {
    return fromPromise(
      async () => {
        await this.dbClient.cx.organizationInvitation.update({
          where: {
            organizationId_id: {organizationId: context.organizationId, id: invitation.id},
            AND: {organizationId: invitation.organizationId},
            occ: expectedOcc
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
    if (isPrismaUniqueConstraintError(error, ["token_hash"])) return "resource_already_exists"
    // The transaction boundary owns infrastructure failures and serialization retries.
    return "repository_dependency_error" as const
  }
}

function mapInvitation(row: OrganizationInvitation): E.Either<InvitationValidationError, Invitation> {
  return InvitationFactory.validate({
    ...row,
    inviteeAccountId: row.targetAccountId,
    orgRole: row.requestedOrgRole,
    acceptedAt: row.acceptedAt ?? undefined,
    revokedAt: row.revokedAt ?? undefined
  })
}
