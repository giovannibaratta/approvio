import {Injectable, Logger} from "@nestjs/common"
import {Space, SpaceFactory, TenantContext, Versioned} from "@domain"
import {
  CreateSpaceRepoError,
  CreateSpaceWithUserPermissionsRepo,
  DeleteSpaceRepo,
  DeleteSpaceRepoError,
  GetSpaceByIdRepo,
  GetSpaceByNameRepo,
  GetSpaceRepoError,
  ListSpacesRepo,
  ListSpacesRepoError,
  ListSpacesResult,
  SpaceRepository
} from "@services"
import {Prisma, Space as PrismaSpace} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {SpaceTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import {mapRolesToPrisma} from "./shared"
import {chainNullableToLeft} from "./utils"

@Injectable()
export class SpaceDbRepository implements SpaceRepository {
  constructor(private readonly dbClient: SpaceTenantClient) {}

  createSpaceWithUserPermissions(
    context: TenantContext,
    data: CreateSpaceWithUserPermissionsRepo
  ): TE.TaskEither<CreateSpaceRepoError, Space> {
    return pipe(
      TE.tryCatch(
        async () => {
          // TODO: These checks do not belong here
          if (
            context.organizationId !== data.space.organizationId ||
            context.organizationId !== data.user.organizationId
          )
            throw new SpaceConflictError()
          const space = await this.dbClient.cx.space.create({
            data: {
              id: data.space.id,
              organizationId: context.organizationId,
              name: data.space.name,
              description: data.space.description ?? null,
              createdAt: data.space.createdAt,
              updatedAt: data.space.updatedAt,
              occ: 0n
            }
          })
          await this.dbClient.cx.user.update({
            where: {id: data.user.id, organizationId: context.organizationId, occ: data.userOcc},
            data: {
              displayName: data.user.displayName,
              roles: mapRolesToPrisma(data.user.roles),
              updatedAt: new Date(),
              occ: {increment: 1}
            }
          })
          return space
        },
        error => this.mapCreateError(error)
      ),
      TE.chainEitherKW(record => E.mapLeft(() => "unknown_error" as const)(mapSpace(record)))
    )
  }

  getSpaceById(context: TenantContext, data: GetSpaceByIdRepo): TE.TaskEither<GetSpaceRepoError, Versioned<Space>> {
    return this.get({organizationId_id: {organizationId: context.organizationId, id: data.spaceId}})
  }
  getSpaceByName(context: TenantContext, data: GetSpaceByNameRepo): TE.TaskEither<GetSpaceRepoError, Versioned<Space>> {
    return this.get({organizationId_name: {organizationId: context.organizationId, name: data.spaceName}})
  }
  getSpacesByIds(
    context: TenantContext,
    spaceIds: string[]
  ): TE.TaskEither<"unknown_error", {id: string; name: string}[]> {
    return TE.tryCatch(
      () =>
        this.dbClient.cx.space.findMany({
          where: {organizationId: context.organizationId, id: {in: spaceIds}},
          select: {id: true, name: true}
        }),
      error => this.unknown(error, "get by ids")
    )
  }
  listSpaces(context: TenantContext, data: ListSpacesRepo): TE.TaskEither<ListSpacesRepoError, ListSpacesResult> {
    if (data.page < 1) return TE.left("invalid_page")
    if (data.limit < 1) return TE.left("invalid_limit")
    const where = {
      organizationId: context.organizationId,
      ...(data.search ? {name: {contains: data.search, mode: "insensitive" as const}} : {})
    }
    return pipe(
      TE.tryCatch(
        async () => {
          const [spaces, total] = await Promise.all([
            this.dbClient.cx.space.findMany({
              where,
              orderBy: {createdAt: "asc"},
              skip: (data.page - 1) * data.limit,
              take: data.limit
            }),
            this.dbClient.cx.space.count({where})
          ])
          return {spaces, total}
        },
        error => this.unknown(error, "list")
      ),
      TE.chainEitherKW(({spaces, total}): E.Either<"unknown_error", ListSpacesResult> => {
        const mapped = spaces.map(mapSpace)
        const invalid = mapped.find(E.isLeft)
        return invalid
          ? E.left(invalid.left)
          : E.right({
              spaces: mapped.map(value => (value as E.Right<Versioned<Space>>).right),
              total,
              page: data.page,
              limit: data.limit
            })
      })
    )
  }
  deleteSpace(context: TenantContext, data: DeleteSpaceRepo): TE.TaskEither<DeleteSpaceRepoError, void> {
    return TE.tryCatch(
      async () => {
        const deleted = await this.dbClient.cx.space.deleteMany({
          where: {organizationId: context.organizationId, id: data.spaceId}
        })
        if (deleted.count !== 1) throw new SpaceNotFoundError()
      },
      error => (error instanceof SpaceNotFoundError ? "space_not_found" : this.unknown(error, "delete"))
    )
  }
  countSpaces(context: TenantContext): TE.TaskEither<"unknown_error", number> {
    return TE.tryCatch(
      () => this.dbClient.cx.space.count({where: {organizationId: context.organizationId}}),
      error => this.unknown(error, "count")
    )
  }
  private get(where: Prisma.SpaceWhereUniqueInput): TE.TaskEither<GetSpaceRepoError, Versioned<Space>> {
    return pipe(
      TE.tryCatch(
        () => this.dbClient.cx.space.findUnique({where}),
        error => this.unknown(error, "get")
      ),
      chainNullableToLeft("space_not_found" as const),
      TE.chainEitherKW(mapSpace)
    )
  }
  private mapCreateError(error: unknown): CreateSpaceRepoError {
    if (isPrismaUniqueConstraintError(error, ["organization_id", "name"], "spaces_organization_name_unique"))
      return "space_already_exists"
    if (isPrismaRecordNotFoundError(error, Prisma.ModelName.User)) return "concurrency_error"
    if (error instanceof SpaceConflictError) return "concurrency_error"
    return this.unknown(error, "create")
  }
  private unknown(error: unknown, operation: string): "unknown_error" {
    Logger.error(`Space repository ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }
}
function mapSpace(record: PrismaSpace): E.Either<"unknown_error", Versioned<Space>> {
  return E.mapLeft(() => "unknown_error" as const)(
    pipe(
      SpaceFactory.validate({
        id: record.id,
        organizationId: record.organizationId,
        name: record.name,
        description: record.description ?? undefined,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      }),
      E.map(space => ({...space, occ: record.occ}))
    )
  )
}
class SpaceNotFoundError extends Error {}
class SpaceConflictError extends Error {}
