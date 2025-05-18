import {
  GroupValidationError,
  Membership,
  MembershipFactory,
  MembershipValidationError,
  MembershipValidationErrorWithGroupRef,
  MembershipWithGroupRef
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
import {mapToDomainVersionedGroup} from "./shared"
import {chainNullableToLeft} from "./utils"

type GroupWithMemberships = PrismaGroup & {groupMemberships: PrismaGroupMembership[]}

@Injectable()
export class GroupMembershipDbRepository implements GroupMembershipRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  getGroupWithMembershipById(
    data: GetGroupWithMembershipRepo
  ): TaskEither<GetGroupRepoError | MembershipValidationError, GetGroupMembershipResult> {
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
  ): TaskEither<MembershipValidationErrorWithGroupRef | UnknownError, ReadonlyArray<MembershipWithGroupRef>> {
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
              groupMemberships: true
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
          if (isPrismaForeignKeyConstraintError(error, "fk_group_memberships_group (index)")) return "group_not_found"
          if (isPrismaForeignKeyConstraintError(error, "fk_group_memberships_user (index)")) return "user_not_found"
          if (isPrismaUniqueConstraintError(error, ["group_id", "user_id"])) return "entity_already_in_group"
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
          role: m.role,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt
        }))
      })

      const updatedGroup = await tx.group.update({
        where: {id: data.group.id, occ: data.group.occ},
        data: {updatedAt: new Date()},
        include: {groupMemberships: true}
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
        include: {groupMemberships: true}
      })

      if (!updatedGroup) throw new ConcurrentModificationError("Group not found or version mismatch")

      return updatedGroup
    })
  }

  private getUserMembershipsByUserIdTask(): (
    userId: string
  ) => TaskEither<UnknownError, ReadonlyArray<PrismaGroupMembership>> {
    return userId =>
      TE.tryCatchK(
        () => this.dbClient.groupMembership.findMany({where: {userId}}),
        error => {
          Logger.error("Error while retrieving user memberships. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }
}

function mapMembershipToDomain(dbObject: PrismaGroupMembership): Either<MembershipValidationError, Membership> {
  return pipe(
    dbObject,
    data => ({entity: data.userId, role: data.role, createdAt: data.createdAt, updatedAt: data.updatedAt}),
    MembershipFactory.validate
  )
}

function mapToVersionedDomainWithMembership(
  dbObject: GroupWithMemberships
): Either<GroupValidationError | MembershipValidationError, GetGroupMembershipResult> {
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
  dbObject: ReadonlyArray<PrismaGroupMembership>
): Either<MembershipValidationErrorWithGroupRef, ReadonlyArray<MembershipWithGroupRef>> {
  return pipe([...dbObject], A.traverse(E.Applicative)(mapToDomainMembershipWithGroupRef))
}

function mapToDomainMembershipWithGroupRef(
  dbObject: Readonly<PrismaGroupMembership>
): Either<MembershipValidationErrorWithGroupRef, MembershipWithGroupRef> {
  return pipe(
    dbObject,
    data => ({
      entity: data.userId,
      role: data.role,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      groupId: data.groupId
    }),
    MembershipFactory.validateWithGroupRef
  )
}

class ConcurrentModificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConcurrentModificationError"
  }
}
