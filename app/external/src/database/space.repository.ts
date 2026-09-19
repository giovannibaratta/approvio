import {fromPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {Space, SpaceFactory, SpaceValidationError, TenantContext, Versioned} from "@domain"
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
import {TaskEither} from "fp-ts/TaskEither"
import {SpaceTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import {persistExistingUserRaceConditionFree} from "./shared"
import {chainNullableToLeft} from "./utils"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"

@Injectable()
export class SpaceDbRepository implements SpaceRepository {
  constructor(private readonly dbClient: SpaceTenantClient) {}

  createSpaceWithUserPermissions(
    context: TenantContext,
    data: CreateSpaceWithUserPermissionsRepo
  ): TE.TaskEither<CreateSpaceRepoError, Space> {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.persistNewSpaceWithUserPermissionsTask(context)),
      TE.chainEitherKW(mapToDomainVersionedSpace)
    )
  }

  private persistNewSpaceWithUserPermissionsTask(
    context: TenantContext
  ): (data: CreateSpaceWithUserPermissionsRepo) => TaskEither<CreateSpaceRepoError, PrismaSpace> {
    return data =>
      fromPromise(
        async () => {
          // 1. Create the space
          const space = await this.dbClient.cx.space.create({
            data: {
              id: data.space.id,
              organizationId: data.space.organizationId,
              name: data.space.name,
              description: data.space.description ?? null,
              createdAt: data.space.createdAt,
              updatedAt: data.space.updatedAt,
              occ: POSTGRES_BIGINT_LOWER_BOUND
            }
          })
          // 2. Update user with new permissions using shared function
          await persistExistingUserRaceConditionFree(this.dbClient.cx, {
            userId: data.user.id,
            organizationId: context.organizationId,
            userOcc: data.userOcc,
            displayName: data.user.displayName,
            roles: data.user.roles,
            createdAt: data.user.createdAt,
            updatedAt: data.user.updatedAt
          })
          return space
        },
        error => this.mapCreateError(error)
      )
  }

  getSpaceById(context: TenantContext, data: GetSpaceByIdRepo): TE.TaskEither<GetSpaceRepoError, Versioned<Space>> {
    return this.getSpace(context, {identifier: {type: "id", value: data.spaceId}})
  }
  getSpaceByName(context: TenantContext, data: GetSpaceByNameRepo): TE.TaskEither<GetSpaceRepoError, Versioned<Space>> {
    return this.getSpace(context, {identifier: {type: "name", value: data.spaceName}})
  }
  getSpacesByIds(
    context: TenantContext,
    spaceIds: string[]
  ): TE.TaskEither<"unknown_error", {id: string; name: string}[]> {
    return fromPromise(
      () =>
        this.dbClient.cx.space.findMany({
          where: {organizationId: context.organizationId, id: {in: spaceIds}},
          select: {id: true, name: true}
        }),
      error => this.unknown(error, "get by ids")
    )
  }
  private getSpace(
    context: TenantContext,
    request: GetSpaceTaskRequest
  ): TaskEither<GetSpaceRepoError, Versioned<Space>> {
    return pipe(
      request,
      TE.right,
      TE.chainW(this.getSpaceTask(context)),
      chainNullableToLeft("space_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedSpace)
    )
  }

  listSpaces(context: TenantContext, data: ListSpacesRepo): TaskEither<ListSpacesRepoError, ListSpacesResult> {
    const {page, limit, search} = data
    const options: ListOptions = {take: limit, skip: (page - 1) * limit, search}

    return pipe(
      options,
      TE.right,
      TE.chainW(this.getSpacesTask(context)),
      TE.chainEitherKW(([spaces, total]) =>
        pipe(
          E.traverseArray(mapToDomainVersionedSpace)(spaces),
          E.map(mapped => ({spaces: mapped, total, page, limit}))
        )
      )
    )
  }

  deleteSpace(context: TenantContext, data: DeleteSpaceRepo): TaskEither<DeleteSpaceRepoError, void> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.space.delete({
            where: {organizationId_id: {organizationId: context.organizationId, id: data.spaceId}}
          }),
        error => {
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Space)) return "space_not_found" as const
          return this.unknown(error, "delete")
        }
      ),
      TE.map(() => undefined)
    )
  }

  countSpaces(context: TenantContext): TE.TaskEither<"unknown_error", number> {
    return fromPromise(
      () => this.dbClient.cx.space.count({where: {organizationId: context.organizationId}}),
      error => this.unknown(error, "count")
    )
  }
  private buildWhereClauseGetSpaceTask(
    context: TenantContext,
    request: GetSpaceTaskRequest
  ): Prisma.SpaceWhereUniqueInput {
    return request.identifier.type === "id"
      ? {organizationId_id: {organizationId: context.organizationId, id: request.identifier.value}}
      : {organizationId_name: {organizationId: context.organizationId, name: request.identifier.value}}
  }

  private getSpaceTask(
    context: TenantContext
  ): (request: GetSpaceTaskRequest) => TaskEither<GetSpaceRepoError, PrismaSpace | null> {
    return request =>
      fromPromise(
        () => this.dbClient.cx.space.findUnique({where: this.buildWhereClauseGetSpaceTask(context, request)}),
        error => this.unknown(error, "get")
      )
  }

  private getSpacesTask(
    context: TenantContext
  ): (options: ListOptions) => TaskEither<ListSpacesRepoError, [PrismaSpace[], number]> {
    return options =>
      fromPromise(
        () => {
          // The page and count must observe the same snapshot in the caller's transaction.
          this.dbClient.assertIsolationLevel(Prisma.TransactionIsolationLevel.RepeatableRead)
          const whereClause: Prisma.SpaceWhereInput = {
            organizationId: context.organizationId,
            ...(options.search ? {name: {contains: options.search, mode: "insensitive"}} : {})
          }
          return Promise.all([
            this.dbClient.cx.space.findMany({
              take: options.take,
              skip: options.skip,
              where: whereClause,
              orderBy: {createdAt: "asc"}
            }),
            this.dbClient.cx.space.count({where: whereClause})
          ])
        },
        error => this.unknown(error, "list")
      )
  }

  private mapCreateError(error: unknown): CreateSpaceRepoError {
    if (isPrismaUniqueConstraintError(error, ["organization_id", "name"], "spaces_organization_name_unique"))
      return "space_already_exists"
    if (isPrismaRecordNotFoundError(error, Prisma.ModelName.User)) return "concurrency_error"
    return this.unknown(error, "create")
  }
  private unknown(error: unknown, operation: string): "unknown_error" {
    Logger.error(`Space repository ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }
}

interface GetSpaceTaskRequest {
  identifier: {
    type: "id" | "name"
    value: string
  }
}

interface ListOptions {
  take: number
  skip: number
  search?: string
}

function mapToDomainVersionedSpace(record: PrismaSpace): E.Either<SpaceValidationError, Versioned<Space>> {
  return pipe(
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
}
