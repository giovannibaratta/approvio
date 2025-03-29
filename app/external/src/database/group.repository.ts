import {Group, GroupFactory, GroupValidationError} from "@domain"
import {isPrismaUniqueConstraintError} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, Group as PrismaGroup} from "@prisma/client"
import {GroupCreateError, GroupGetError, GroupListError, GroupRepository, ListGroupsResult} from "@services"
import * as E from "fp-ts/lib/Either"
import {Either, isLeft} from "fp-ts/lib/Either"
import * as TE from "fp-ts/lib/TaskEither"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {DatabaseClient} from "./database-client"

interface Identifier {
  identifier: string
  type: "id" | "name"
}

interface ListOptions {
  take: number
  skip: number
}

@Injectable()
export class GroupDbRepository implements GroupRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  createGroup(group: Group): TaskEither<GroupCreateError, Group> {
    return pipe(group, TE.right, TE.chainW(this.persistObjectTask()), TE.chainEitherKW(mapToDomain))
  }

  getGroupById(groupId: string): TaskEither<GroupGetError, Group> {
    const identifier: Identifier = {type: "id", identifier: groupId}
    return this.getGroup(identifier)
  }

  getGroupByName(groupName: string): TaskEither<GroupGetError, Group> {
    const identifier: Identifier = {type: "name", identifier: groupName}
    return this.getGroup(identifier)
  }

  private getGroup(identifier: Identifier): TaskEither<GroupGetError, Group> {
    return pipe(
      identifier,
      TE.right,
      TE.chainW(this.getObjectTask()),
      chainNullableToLeft("group_not_found" as const),
      TE.chainEitherKW(mapToDomain)
    )
  }

  listGroups(page: number, limit: number): TaskEither<GroupListError, ListGroupsResult> {
    const skip = (page - 1) * limit
    const take = limit

    const options: ListOptions = {
      take,
      skip
    }

    return pipe(
      options,
      TE.right,
      TE.chainW(this.getObjectsTask()),
      TE.chainEitherKW(([groups, total]) => {
        const domainGroups = groups.map(group => mapToDomain(group))

        if (areAllRights(domainGroups)) {
          const mappedToDomain = {
            groups: domainGroups.map(e => e.right),
            total,
            page,
            limit
          }
          return E.right(mappedToDomain)
        }

        const lefts = domainGroups.filter(e => isLeft(e))
        const firstLeft = lefts[0]
        if (firstLeft === undefined) throw new Error("Unexpected error: No rights and no lefts")
        return firstLeft
      })
    )
  }

  private persistObjectTask(): (group: Group) => TaskEither<GroupCreateError, PrismaGroup> {
    // Wrap in a lambda to preserve the "this" context
    return group =>
      TE.tryCatchK(
        () =>
          this.dbClient.group.create({
            data: {
              createdAt: group.createdAt,
              id: group.id,
              name: group.name,
              description: group.description,
              updatedAt: group.updatedAt
            }
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["name"])) return "group_already_exists"

          Logger.error("Error while creating group. Unknown error", error)
          return "unknown_error"
        }
      )()
  }

  private getObjectTask(): (identifier: Identifier) => TaskEither<GroupGetError, PrismaGroup | null> {
    // Wrap in a lambda to preserve the "this" context
    return identifier =>
      TE.tryCatchK(
        () =>
          this.dbClient.group.findUnique({
            where: {
              id: identifier.type === "id" ? identifier.identifier : undefined,
              name: identifier.type === "name" ? identifier.identifier : undefined
            }
          }),
        error => {
          Logger.error("Error while retrieving group. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  private getObjectsTask(): (options: ListOptions) => TaskEither<GroupListError, [PrismaGroup[], number]> {
    // Wrap in a lambda to preserve the "this" context
    return options =>
      TE.tryCatchK(
        () => {
          const data = this.dbClient.group.findMany({
            take: options.take,
            skip: options.skip
          })
          const stats = this.dbClient.group.count()

          return this.dbClient.$transaction([data, stats], {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
          })
        },
        error => {
          Logger.error("Error while retrieving groups. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }
}

function mapToDomain(dbObject: PrismaGroup): Either<GroupValidationError, Group> {
  const object: Group = {
    createdAt: dbObject.createdAt,
    description: dbObject.description,
    id: dbObject.id,
    name: dbObject.name,
    updatedAt: dbObject.updatedAt
  }

  return pipe(object, GroupFactory.validate)
}

/**
 * Chainable that can be used to convert a non-defined value to a Left value.
 * @param onNullable Left value to return if the value is null or undefined.
 */
const chainNullableToLeft =
  <L>(onNullable: L) =>
  <A, B>(taskEither: TE.TaskEither<A, B | null | undefined>): TE.TaskEither<A | L, NonNullable<B>> => {
    return pipe(
      taskEither,
      // chainEitherKW applies an Either-returning function to the Right value
      // and automatically widens the Error channel (A | L)
      TE.chainEitherKW(
        // E.fromNullable creates an Either from a potentially nullable value.
        // It takes the error value (or a function returning it) as the first argument.
        // If the value passed to the resulting function is null/undefined, it returns Left(onNullable()).
        // Otherwise, it returns Right(value).
        E.fromNullable(onNullable)
      )
    )
  }

/**
 * Type guard to check if all elements are of type Right
 */
function areAllRights<A, B>(arr: Array<Either<A, B>>): arr is Array<E.Right<B>> {
  return arr.every(E.isRight)
}
