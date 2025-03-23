import {Group} from "@domain"
import {Injectable, Logger} from "@nestjs/common"
import {DatabaseClient} from "./database-client"
import {GroupCreateError, GroupRepository} from "@services"
import {Group as PrismaGroup} from "@prisma/client"
import * as TE from "fp-ts/lib/TaskEither"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {isPrismaUniqueConstraintError} from "@external/database/errors"

@Injectable()
export class GroupDbRepository implements GroupRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  createGroup(group: Group): TaskEither<GroupCreateError, Group> {
    return pipe(group, TE.right, TE.chainW(this.persistObjectTask()), TE.map(mapToDomain))
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
              updatedAt: group.updatedAt
            }
          }),
        error => {

          if (isPrismaUniqueConstraintError(error, ["name"]))
            return "group_already_exists"

          Logger.error("Error while creating group. Unknown error", error)
          return "unknown_error"
        }
      )()
  }
}

function mapToDomain(dbObject: PrismaGroup): Group {
  return {
    createdAt: dbObject.createdAt,
    description: dbObject.description,
    id: dbObject.id,
    name: dbObject.name,
    updatedAt: dbObject.updatedAt
  }
}
