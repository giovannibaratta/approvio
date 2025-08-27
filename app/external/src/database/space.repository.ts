import {Space} from "@domain"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, Space as PrismaSpace} from "@prisma/client"
import {
  CreateSpaceRepoError,
  CreateSpaceWithUserPermissionsRepo,
  GetSpaceByIdRepo,
  GetSpaceByNameRepo,
  GetSpaceRepoError,
  SpaceRepository,
  ListSpacesRepo,
  ListSpacesRepoError,
  ListSpacesResult,
  DeleteSpaceRepoError,
  DeleteSpaceRepo
} from "@services"
import {Versioned} from "@services/shared/utils"
import * as E from "fp-ts/lib/Either"
import * as TE from "fp-ts/lib/TaskEither"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {DatabaseClient} from "./database-client"
import {mapToDomainVersionedSpace} from "./shared"
import {persistExistingUserRaceConditionFree} from "./shared/user-operations"
import {areAllRights, chainNullableToLeft} from "./utils"

@Injectable()
export class SpaceDbRepository implements SpaceRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  createSpaceWithUserPermissions(data: CreateSpaceWithUserPermissionsRepo): TaskEither<CreateSpaceRepoError, Space> {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.persistNewSpaceWithUserPermissionsTask()),
      TE.chainEitherKW(mapToDomainVersionedSpace)
    )
  }

  private persistNewSpaceWithUserPermissionsTask(): (
    data: CreateSpaceWithUserPermissionsRepo
  ) => TaskEither<CreateSpaceRepoError, PrismaSpace> {
    return data =>
      TE.tryCatchK(
        () =>
          this.dbClient.$transaction(async tx => {
            // 1. Create the space
            const createdSpace = await tx.space.create({
              data: {
                createdAt: data.space.createdAt,
                id: data.space.id,
                name: data.space.name,
                description: data.space.description,
                updatedAt: data.space.updatedAt,
                occ: POSTGRES_BIGINT_LOWER_BOUND
              }
            })

            // 2. Update user with new permissions using shared function
            await persistExistingUserRaceConditionFree(tx, {
              userId: data.user.id,
              userOcc: data.userOcc,
              displayName: data.user.displayName,
              email: data.user.email,
              roles: data.user.roles,
              createdAt: data.user.createdAt
            })

            return createdSpace
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["name"])) return "space_already_exists"

          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.User)) return "concurrency_error"

          Logger.error("Error while creating space. Unknown error", error)
          return "unknown_error"
        }
      )()
  }

  getSpaceById(data: GetSpaceByIdRepo): TaskEither<GetSpaceRepoError, Versioned<Space>> {
    return this.getSpace({identifier: {type: "id", value: data.spaceId}})
  }

  getSpaceByName(data: GetSpaceByNameRepo): TaskEither<GetSpaceRepoError, Versioned<Space>> {
    return this.getSpace({identifier: {type: "name", value: data.spaceName}})
  }

  private getSpace(request: GetSpaceTaskRequest): TaskEither<GetSpaceRepoError, Versioned<Space>> {
    return pipe(
      request,
      TE.right,
      TE.chainW(this.getSpaceTask()),
      chainNullableToLeft("space_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedSpace)
    )
  }

  listSpaces(data: ListSpacesRepo): TaskEither<ListSpacesRepoError, ListSpacesResult> {
    const {page, limit} = data

    const skip = (page - 1) * limit
    const take = limit

    const options: ListOptions = {
      take,
      skip
    }

    return pipe(
      options,
      TE.right,
      TE.chainW(this.getSpacesTask()),
      TE.chainEitherKW(([spaces, total]) => {
        const domainSpaces = spaces.map(space => mapToDomainVersionedSpace(space))

        if (areAllRights(domainSpaces)) {
          const mappedToDomain = {
            spaces: domainSpaces.map(e => e.right),
            total,
            page,
            limit
          }
          return E.right(mappedToDomain)
        }

        return E.left("unknown_error" as const)
      })
    )
  }

  deleteSpace(data: DeleteSpaceRepo): TaskEither<DeleteSpaceRepoError, void> {
    return pipe(
      TE.tryCatchK(
        () =>
          this.dbClient.space.delete({
            where: {id: data.spaceId}
          }),
        error => {
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Space)) return "space_not_found"

          Logger.error("Error while deleting space. Unknown error", error)
          return "unknown_error"
        }
      )(),
      TE.map(() => undefined)
    )
  }

  private buildWhereClauseGetSpaceTask(request: GetSpaceTaskRequest): Prisma.SpaceWhereUniqueInput {
    return request.identifier.type === "id" ? {id: request.identifier.value} : {name: request.identifier.value}
  }

  private getSpaceTask(): (request: GetSpaceTaskRequest) => TaskEither<GetSpaceRepoError, PrismaSpace | null> {
    return request =>
      TE.tryCatchK(
        () =>
          this.dbClient.space.findUnique({
            where: this.buildWhereClauseGetSpaceTask(request)
          }),
        error => {
          Logger.error("Error while retrieving space. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  private getSpacesTask(): (options: ListOptions) => TaskEither<ListSpacesRepoError, [PrismaSpace[], number]> {
    return options =>
      TE.tryCatchK(
        () => {
          const data = this.dbClient.space.findMany({
            take: options.take,
            skip: options.skip,
            orderBy: {
              createdAt: "asc"
            }
          })
          const stats = this.dbClient.space.count()

          return this.dbClient.$transaction([data, stats], {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
          })
        },
        error => {
          Logger.error("Error while retrieving spaces. Unknown error", error)
          return "unknown_error" as const
        }
      )()
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
}
