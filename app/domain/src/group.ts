import {Either, left, right, isLeft} from "fp-ts/Either"
import {randomUUID} from "crypto"
import {hasOwnProperty} from "./utils"
import {OrgRole, User} from "@domain"

export const NAME_MAX_LENGTH = 512
export const DESCRIPTION_MAX_LENGTH = 2048

export type Group = Readonly<PrivateGroup>

interface PrivateGroup {
  id: string
  name: string
  description: string | null
  createdAt: Date
  updatedAt: Date
}

export interface GroupWithEntitiesCount extends Group {
  readonly entitiesCount: number
}

export type GroupProps = keyof Group | keyof GroupWithEntitiesCount

export type GroupValidationError =
  | NameValidationError
  | TimestampValidationError
  | DescriptionValidationError
  | "entities_count_invalid"
export type TimestampValidationError = "update_before_create"
export type NameValidationError = "name_empty" | "name_too_long" | "name_invalid_characters"
export type DescriptionValidationError = "description_too_long"

export class GroupFactory {
  static validate<T extends Group>(data: T): Either<GroupValidationError, T> {
    return GroupFactory.createGroup(data)
  }

  static newGroup(data: Omit<Group, "id" | "createdAt" | "updatedAt">): Either<GroupValidationError, Group> {
    const uuid = randomUUID()
    const now = new Date()
    const group: Group = {
      ...data,
      id: uuid,
      createdAt: now,
      updatedAt: now
    }

    return GroupFactory.validate(group)
  }

  private static createGroup<T extends Group>(data: T): Either<GroupValidationError, T> {
    const nameValidation = validateGroupName(data.name)
    const descriptionValidation = data.description ? validateGroupDescription(data.description) : right(null)
    const additionalProps: Partial<Record<GroupProps, unknown>> = {}

    if (isLeft(nameValidation)) return nameValidation
    if (isLeft(descriptionValidation)) return descriptionValidation
    if (data.createdAt > data.updatedAt) return left("update_before_create")

    if (isGroupWithEntitiesCount(data)) {
      if (data.entitiesCount < 0) return left("entities_count_invalid")
      additionalProps.entitiesCount = data.entitiesCount
    }

    return right({...data, name: nameValidation.right, description: descriptionValidation.right, ...additionalProps})
  }
}

function isGroupWithEntitiesCount(group: Group): group is GroupWithEntitiesCount {
  return hasOwnProperty(group, "entitiesCount") && typeof group.entitiesCount === "number"
}

function validateGroupDescription(description: string): Either<DescriptionValidationError, string> {
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    return left("description_too_long")
  }

  return right(description)
}

function validateGroupName(name: string): Either<NameValidationError, string> {
  if (!name || name.trim().length === 0) {
    return left("name_empty")
  }

  if (name.length > NAME_MAX_LENGTH) {
    return left("name_too_long")
  }

  return right(name)
}

export type ListGroupsFilter = ListAllGroupsFilter | ListGroupsWhereRequestorIsMemberFilter

interface ListAllGroupsFilter {
  type: "all"
}
interface ListGroupsWhereRequestorIsMemberFilter {
  type: "direct_member"
  requestor: User
}

export class ListFilterFactory {
  static generateListFiltersForRequestor(requestor: User): ListGroupsFilter {
    switch (requestor.orgRole) {
      case OrgRole.ADMIN:
        return {type: "all"} as ListAllGroupsFilter
      case OrgRole.MEMBER:
        return {type: "direct_member", requestor} as ListGroupsWhereRequestorIsMemberFilter
    }
  }
}
