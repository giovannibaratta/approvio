import {OrganizationAdmin} from "@domain"
import {isPrismaUniqueConstraintError, isPrismaForeignKeyConstraintError} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {OrganizationAdmin as PrismaOrganizationAdmin, Prisma} from "@prisma/client"
import {
  OrganizationAdminCreateError,
  OrganizationAdminListError,
  OrganizationAdminRemoveError,
  OrganizationAdminRepository,
  PaginatedOrganizationAdminsList,
  ListOrganizationAdminsRepoRequest
} from "@services"
import * as TE from "fp-ts/lib/TaskEither"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {DatabaseClient} from "./database-client"
import {mapOrganizationAdminToDomain} from "./shared"
import * as E from "fp-ts/lib/Either"
import {traverseArray} from "fp-ts/lib/Either"

@Injectable()
export class OrganizationAdminDbRepository implements OrganizationAdminRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  createOrganizationAdmin(admin: OrganizationAdmin): TaskEither<OrganizationAdminCreateError, OrganizationAdmin> {
    return pipe(admin, TE.right, TE.chainW(this.persistObjectTask()), TE.chainEitherKW(mapOrganizationAdminToDomain))
  }

  listOrganizationAdmins(
    params: ListOrganizationAdminsRepoRequest
  ): TaskEither<OrganizationAdminListError, PaginatedOrganizationAdminsList> {
    return pipe(params, this.getObjectsTask(), TE.chainEitherKW(this.mapToOrganizationAdminsList(params)))
  }

  removeOrganizationAdminIfNotLast(userId: string): TaskEither<OrganizationAdminRemoveError, void> {
    return pipe(
      userId,
      this.deleteObjectTask(),
      TE.map(() => undefined)
    )
  }

  removeOrganizationAdminByEmailIfNotLast(email: string): TaskEither<OrganizationAdminRemoveError, void> {
    return pipe(
      email,
      this.deleteObjectByEmailTask(),
      TE.map(() => undefined)
    )
  }

  private persistObjectTask(): (
    admin: OrganizationAdmin
  ) => TaskEither<OrganizationAdminCreateError, PrismaOrganizationAdmin> {
    return admin =>
      TE.tryCatchK(
        () =>
          this.dbClient.organizationAdmin.create({
            data: {
              id: admin.id,
              email: admin.email,
              createdAt: admin.createdAt
            }
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["email"])) return "organization_admin_already_exists"
          if (isPrismaForeignKeyConstraintError(error, "fk_organization_admins_user")) return "user_not_found"

          Logger.error("Error while creating organization admin. Unknown error", error)
          return "unknown_error"
        }
      )()
  }

  private getObjectsTask(): (
    request: ListOrganizationAdminsRepoRequest
  ) => TaskEither<OrganizationAdminListError, [PrismaOrganizationAdmin[], number]> {
    return request =>
      TE.tryCatchK(
        () => {
          const {page, limit} = request
          const skip = (page - 1) * limit

          const data = this.dbClient.organizationAdmin.findMany({
            take: limit,
            skip,
            orderBy: {
              createdAt: "asc"
            }
          })

          const count = this.dbClient.organizationAdmin.count()

          return Promise.all([data, count])
        },
        error => {
          Logger.error("Error while listing organization admins. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  private deleteObjectTask(): (userId: string) => TaskEither<OrganizationAdminRemoveError, number> {
    return userId => this.deleteWithWhereClause({users: {id: userId}})
  }

  private deleteObjectByEmailTask(): (email: string) => TaskEither<OrganizationAdminRemoveError, number> {
    return email => this.deleteWithWhereClause({email})
  }

  private deleteWithWhereClause(
    whereClause: Prisma.OrganizationAdminWhereInput
  ): TaskEither<OrganizationAdminRemoveError, number> {
    return TE.tryCatchK(
      async () => {
        const count = await this.dbClient.$transaction(
          async tx => {
            const deleted = await tx.organizationAdmin.deleteMany({where: whereClause})
            const remaining = await tx.organizationAdmin.count({})

            if (remaining < 1) throw new EmptyOrganizationAdminError()
            return deleted.count
          },
          {
            // We want strong consistency to avoid race conditions and leave the organization
            // in an invalid state (0 admins)
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
          }
        )

        return count
      },
      error => {
        if (error instanceof EmptyOrganizationAdminError) return "organization_admin_is_last" as const
        Logger.error("Error while removing organization admin. Unknown error", error)
        return "unknown_error" as const
      }
    )()
  }

  private mapToOrganizationAdminsList(
    request: ListOrganizationAdminsRepoRequest
  ): (
    data: [PrismaOrganizationAdmin[], number]
  ) => E.Either<OrganizationAdminListError, PaginatedOrganizationAdminsList> {
    return data => {
      const [admins, total] = data

      return pipe(
        admins,
        traverseArray(mapOrganizationAdminToDomain),
        E.map(domainAdmins => ({
          admins: domainAdmins,
          page: request.page,
          limit: request.limit,
          total
        }))
      )
    }
  }
}

class EmptyOrganizationAdminError extends Error {
  constructor() {
    super("Organization admin is empty")
  }
}
