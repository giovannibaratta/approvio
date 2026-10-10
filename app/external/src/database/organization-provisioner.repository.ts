import {Injectable} from "@nestjs/common"
import {Organization, PlanTier, TenantContext, User} from "@domain"
import {OrganizationProvisioner, RepositoryDependencyError} from "@services"
import * as TE from "fp-ts/TaskEither"
import {Prisma} from "@prisma/client"
import {OrganizationProvisionerTenantClient} from "./tenant-database-clients"
import {isPrismaUniqueConstraintError} from "./errors"

@Injectable()
export class OrganizationProvisionerDbRepository implements OrganizationProvisioner {
  constructor(private readonly dbClient: OrganizationProvisionerTenantClient) {}

  createOrganization(
    context: TenantContext,
    organization: Organization,
    planTier: PlanTier
  ): TE.TaskEither<"organization_mismatch" | "resource_already_exists" | RepositoryDependencyError, void> {
    if (organization.id !== context.organizationId) return TE.left("organization_mismatch")
    return TE.tryCatch(
      async () => {
        await this.dbClient.cx.organization.createMany({
          data: [
            {
              id: organization.id,
              slug: organization.slug,
              displayName: organization.displayName,
              planTier,
              status: organization.status,
              suspensionReason: organization.status === "suspended" ? organization.suspensionReason : null,
              graceUntil: organization.status === "suspended" ? organization.graceUntil : null,
              createdAt: organization.createdAt,
              updatedAt: organization.updatedAt,
              occ: 0n
            }
          ]
        })
      },
      error => {
        if (
          isPrismaUniqueConstraintError(error, ["id"], "organizations_pkey") ||
          isPrismaUniqueConstraintError(error, ["slug"], "organizations_slug_unique")
        )
          return "resource_already_exists"
        throw error
      }
    )
  }

  createOwner(
    context: TenantContext,
    owner: User
  ): TE.TaskEither<"organization_mismatch" | RepositoryDependencyError, void> {
    if (owner.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    return TE.tryCatch(
      async () => {
        await this.dbClient.cx.user.createMany({
          data: [
            {
              id: owner.id,
              organizationId: context.organizationId,
              platformAccountId: owner.accountId,
              displayName: owner.displayName,
              status: owner.status,
              orgRole: owner.orgRole,
              roles:
                owner.roles.length === 0
                  ? Prisma.JsonNull
                  : owner.roles.map(role => ({name: role.name, scope: {...role.scope}})),
              createdAt: owner.createdAt,
              updatedAt: owner.updatedAt,
              occ: 0n
            }
          ]
        })
      },
      error => {
        throw error
      }
    )
  }
}
