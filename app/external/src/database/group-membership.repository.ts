import {
  GroupValidationError,
  Membership,
  MembershipFactory,
  MembershipValidationError,
  MembershipValidationErrorWithGroupRef,
  MembershipWithGroupRef,
  UserValidationError
} from "@domain"
import {
  isPrismaForeignKeyConstraintError,
  isPrismaRecordNotFoundError,
  isPrismaUniqueConstraintError
} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, Group as PrismaGroup, GroupMembership as PrismaGroupMembership} from "@prisma/client"
import {
  AddMembershipRepoRequest,
  AddMembershipResult,
  GetGroupMembershipResult,
  GetGroupRepoError,
  GetGroupWithMembershipRepo,
  GroupMembershipRepository,
  MembershipAddError,
  MembershipRemoveError,
  RemoveMembershipRepoRequest,
  RemoveMembershipResult,
  UnknownError
} from "@services"
import * as A from "fp-ts/Array"
import {sequenceS} from "fp-ts/lib/Apply"
import * as E from "fp-ts/lib/Either"
import {Either} from "fp-ts/lib/Either"
import * as TE from "fp-ts/lib/TaskEither"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {DatabaseClient} from "./database-client"
import {mapToDomainVersionedGroup, mapUserToDomain} from "./shared"
import {chainNullableToLeft} from "./utils"
import {PrismaUserWithOrgAdmin} from "./user.repository"

type GroupWithMemberships = PrismaGroup & {
  groupMemberships: (PrismaGroupMembership & {users: PrismaUserWithOrgAdmin})[]
}

@Injectable()
export class GroupMembershipDbRepository implements GroupMembershipRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  getGroupWithMembershipById(
    data: GetGroupWithMembershipRepo
  ): TaskEither<GetGroupRepoError | UserValidationError | MembershipValidationError, GetGroupMembershipResult> {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.getObjectTask()),
      chainNullableToLeft("group_not_found" as const),
      TE.chainEitherKW(mapToVersionedDomainWithMembership)
    )
  }

  addMembershipsToGroup(request: AddMembershipRepoRequest): TaskEither<MembershipAddError, AddMembershipResult> {
    return pipe(
      request,
      TE.right,
      TE.chainW(this.createMembershipTask()),
      TE.chainEitherKW(mapToVersionedDomainWithMembership)
    )
  }

  removeMembershipFromGroup(
    request: RemoveMembershipRepoRequest
  ): TaskEither<MembershipRemoveError, RemoveMembershipResult> {
    return pipe(
      request,
      TE.right,
      TE.chainW(this.deleteMembershipTask()),
      TE.chainEitherKW(mapToVersionedDomainWithMembership)
    )
  }

  getUserMembershipsByUserId(
    userId: string
  ): TaskEither<
    MembershipValidationErrorWithGroupRef | UserValidationError | UnknownError,
    ReadonlyArray<MembershipWithGroupRef>
  > {
    return pipe(
      userId,
      TE.right,
      TE.chainW(this.getUserMembershipsByUserIdTask()),
      TE.chainEitherKW(mapToDomainMembershipWithGroupRefs)
    )
  }

  private getObjectTask(): (
    data: GetGroupWithMembershipRepo
  ) => TaskEither<GetGroupRepoError, GroupWithMemberships | null> {
    // Wrap in a lambda to preserve the "this" context
    return data =>
      TE.tryCatchK(
        () =>
          this.dbClient.group.findUnique({
            where: this.buildWhereClauseGetObjectTask(data),
            include: {
              groupMemberships: {
                include: {
                  users: {
                    include: {
                      organizationAdmins: true
                    }
                  }
                }
              }
            }
          }),
        error => {
          Logger.error("Error while retrieving group. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  private buildWhereClauseGetObjectTask(data: GetGroupWithMembershipRepo): Prisma.GroupWhereUniqueInput {
    let groupMembershipClause: Prisma.GroupWhereUniqueInput["groupMemberships"] = undefined

    if (data.onlyIfMember) {
      groupMembershipClause = {
        some: {
          userId: data.onlyIfMember.userId
        }
      }
    }

    return {
      id: data.groupId,
      groupMemberships: groupMembershipClause
    }
  }

  private createMembershipTask(): (
    request: AddMembershipRepoRequest
  ) => TaskEither<MembershipAddError, GroupWithMemberships> {
    return data =>
      TE.tryCatchK(
        () => this.createMembershipWithOccCheck(data),
        error => {
          if (isPrismaForeignKeyConstraintError(error, "fk_group_memberships_group)"))
            return "membership_group_not_found"
          if (isPrismaForeignKeyConstraintError(error, "fk_group_memberships_user")) return "membership_user_not_found"
          if (isPrismaUniqueConstraintError(error, ["group_id", "user_id"])) return "membership_entity_already_in_group"
          if (error instanceof ConcurrentModificationError) return "concurrent_modification_error"
          return "unknown_error"
        }
      )()
  }

  private deleteMembershipTask(): (
    request: RemoveMembershipRepoRequest
  ) => TaskEither<MembershipRemoveError, GroupWithMemberships> {
    return data =>
      TE.tryCatchK(
        () => this.deleteMembershipAndUpdateGroup(data),
        error => {
          if (error instanceof ConcurrentModificationError) return "concurrent_modification_error"
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Group)) return "group_not_found"
          return "unknown_error"
        }
      )()
  }

  private async createMembershipWithOccCheck(data: AddMembershipRepoRequest): Promise<GroupWithMemberships> {
    return this.dbClient.$transaction(async tx => {
      await tx.groupMembership.createMany({
        data: data.memberships.map(m => ({
          groupId: data.group.id,
          userId: m.getEntityId(),
          createdAt: m.createdAt,
          updatedAt: m.updatedAt
        }))
      })

      const updatedGroup = await tx.group.update({
        where: {id: data.group.id, occ: data.group.occ},
        data: {updatedAt: new Date()},
        include: {
          groupMemberships: {
            include: {
              users: {
                include: {
                  organizationAdmins: true
                }
              }
            }
          }
        }
      })

      if (!updatedGroup) throw new ConcurrentModificationError("Group not found or version mismatch")

      return updatedGroup
    })
  }

  private async deleteMembershipAndUpdateGroup(data: RemoveMembershipRepoRequest): Promise<GroupWithMemberships> {
    return this.dbClient.$transaction(async tx => {
      await tx.groupMembership.deleteMany({
        where: {
          groupId: data.groupId,
          userId: {in: [...data.membershipReferences]}
        }
      })

      const updatedGroup = await tx.group.update({
        where: {id: data.groupId},
        data: {updatedAt: new Date()},
        include: {
          groupMemberships: {
            include: {
              users: {
                include: {
                  organizationAdmins: true
                }
              }
            }
          }
        }
      })

      if (!updatedGroup) throw new ConcurrentModificationError("Group not found or version mismatch")

      return updatedGroup
    })
  }

  private getUserMembershipsByUserIdTask(): (
    userId: string
  ) => TaskEither<UnknownError, ReadonlyArray<PrismaGroupMembership & {users: PrismaUserWithOrgAdmin}>> {
    return userId =>
      TE.tryCatchK(
        () =>
          this.dbClient.groupMembership.findMany({
            where: {userId},
            include: {users: {include: {organizationAdmins: true}}}
          }),
        error => {
          Logger.error("Error while retrieving user memberships. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }
}

function mapMembershipToDomain(
  dbObject: PrismaGroupMembership & {users: PrismaUserWithOrgAdmin}
): Either<MembershipValidationError | UserValidationError, Membership> {
  return pipe(
    E.Do,
    E.bindW("user", () => mapUserToDomain(dbObject.users)),
    E.bindW("data", ({user}) => {
      return E.right({
        entity: user,
        createdAt: dbObject.createdAt,
        updatedAt: dbObject.updatedAt
      })
    }),
    E.chainW(({data}) => MembershipFactory.validate(data))
  )
}

function mapToVersionedDomainWithMembership(
  dbObject: GroupWithMemberships
): Either<GroupValidationError | UserValidationError | MembershipValidationError, GetGroupMembershipResult> {
  const eitherGroup = mapToDomainVersionedGroup(dbObject)
  // Map all the memberships to domain and return an error if any of them fail
  const eitherMemberships = pipe(dbObject.groupMemberships, A.traverse(E.Applicative)(mapMembershipToDomain))

  return pipe(
    sequenceS(E.Monad)({
      group: eitherGroup,
      memberships: eitherMemberships
    })
  )
}

function mapToDomainMembershipWithGroupRefs(
  dbObject: ReadonlyArray<PrismaGroupMembership & {users: PrismaUserWithOrgAdmin}>
): Either<MembershipValidationErrorWithGroupRef | UserValidationError, ReadonlyArray<MembershipWithGroupRef>> {
  return pipe([...dbObject], A.traverse(E.Applicative)(mapToDomainMembershipWithGroupRef))
}

function mapToDomainMembershipWithGroupRef(
  dbObject: Readonly<PrismaGroupMembership & {users: PrismaUserWithOrgAdmin}>
): Either<MembershipValidationErrorWithGroupRef | UserValidationError, MembershipWithGroupRef> {
  return pipe(
    E.Do,
    E.bindW("membership", () => mapMembershipToDomain(dbObject)),
    E.bindW("data", ({membership}) => {
      return E.right({
        ...membership,
        groupId: dbObject.groupId
      })
    }),
    E.chainW(({data}) => MembershipFactory.validateWithGroupRef(data))
  )
}

class ConcurrentModificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConcurrentModificationError"
  }
}
