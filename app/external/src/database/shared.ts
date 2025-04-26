import {
  Group,
  GroupFactory,
  GroupValidationError,
  GroupWithEntititesCount,
  User,
  UserFactory,
  UserValidationError
} from "@domain"
import {Group as PrismaGroup} from "@prisma/client"
import {Versioned} from "@services/shared/utils"
import * as E from "fp-ts/lib/Either"
import {Either} from "fp-ts/lib/Either"
import {pipe} from "fp-ts/lib/function"
import {User as PrismaUser} from "@prisma/client"
import {PrismaGroupWithCount} from "./group.repository"

export function mapToDomainVersionedGroup(dbObject: PrismaGroup): Either<GroupValidationError, Versioned<Group>> {
  const object: Group = {
    createdAt: dbObject.createdAt,
    description: dbObject.description,
    id: dbObject.id,
    name: dbObject.name,
    updatedAt: dbObject.updatedAt
  }

  return pipe(
    object,
    GroupFactory.validate,
    E.map(group => ({...group, occ: dbObject.occ}))
  )
}

export function mapToDomainVersionedGroupWithEntities(
  dbObject: PrismaGroupWithCount
): Either<GroupValidationError, Versioned<GroupWithEntititesCount>> {
  const object: GroupWithEntititesCount = {
    createdAt: dbObject.createdAt,
    description: dbObject.description,
    id: dbObject.id,
    name: dbObject.name,
    updatedAt: dbObject.updatedAt,
    entitiesCount: dbObject._count.groupMemberships
  }

  return pipe(
    object,
    GroupFactory.validate,
    E.map(group => ({...group, occ: dbObject.occ}))
  )
}

export function mapToDomainVersionedUser(dbObject: PrismaUser): Either<UserValidationError, Versioned<User>> {
  const object: User = {
    createdAt: dbObject.createdAt,
    id: dbObject.id,
    displayName: dbObject.displayName,
    email: dbObject.email
  }

  return pipe(
    object,
    UserFactory.validate,
    E.map(group => ({...group, occ: dbObject.occ}))
  )
}
