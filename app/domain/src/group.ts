import {Either, left, right, isLeft} from "fp-ts/Either"
import {randomUUID} from "crypto"
import {hasOwnProperty} from "@utils/validation"
import {PrefixUnion} from "@utils"
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

export type GroupValidationError = PrefixUnion<"group", UnprefixedGroupValidationError>

type UnprefixedGroupValidationError =
  | NameValidationError
  | TimestampValidationError
  | DescriptionValidationError
  | "entities_count_invalid"

type TimestampValidationError = "update_before_create"
type NameValidationError = "name_empty" | "name_too_long" | "name_invalid_characters"
type DescriptionValidationError = "description_too_long"

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
    if (data.createdAt > data.updatedAt) return left("group_update_before_create")

    if (isGroupWithEntitiesCount(data)) {
      if (data.entitiesCount < 0) return left("group_entities_count_invalid")
      additionalProps.entitiesCount = data.entitiesCount
    }

    return right({...data, name: nameValidation.right, description: descriptionValidation.right, ...additionalProps})
  }
}

function isGroupWithEntitiesCount(group: Group): group is GroupWithEntitiesCount {
  return hasOwnProperty(group, "entitiesCount") && typeof group.entitiesCount === "number"
}

function validateGroupDescription(description: string): Either<GroupValidationError, string> {
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    return left("group_description_too_long")
  }

  return right(description)
}

function validateGroupName(name: string): Either<GroupValidationError, string> {
  if (!name || name.trim().length === 0) {
    return left("group_name_empty")
  }

  if (name.length > NAME_MAX_LENGTH) {
    return left("group_name_too_long")
  }

  // A valid group name:
  // - Contains only letters (a-z, A-Z), numbers (0-9), or hyphens (-)
  // - Cannot start with a number
  // - Cannot start or end with a hyphen
  if (/[^a-zA-Z0-9-]|(^[-0-9])|(-$)/.test(name)) {
    return left("group_name_invalid_characters")
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
