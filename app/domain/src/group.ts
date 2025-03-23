import {Either, left, right, isLeft} from "fp-ts/Either"
import {randomUUID} from "crypto"

export const NAME_MAX_LENGTH = 512
export const DESCRIPTION_MAX_LENGTH = 2048

export interface Group {
  id: string
  name: string
  description: string | null
  createdAt: Date
  updatedAt: Date
}

export type CreateGroupRequest = Omit<Group, "id" | "createdAt" | "updatedAt">
export type GroupValidationError = NameValidationError | TimestampValidationError | DescriptionValidationError
export type TimestampValidationError = "update_before_create"
export type NameValidationError = "name_empty" | "name_too_long" | "name_invalid_characters"
export type DescriptionValidationError = "description_too_long"

export class GroupFactory {
  static validate(data: Group): Either<GroupValidationError, Group> {
    return GroupFactory.createGroup(data)
  }

  static newGroup(data: CreateGroupRequest): Either<GroupValidationError, Group> {
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

  private static createGroup(data: Group): Either<GroupValidationError, Group> {
    const nameValidation = validateGroupName(data.name)
    const descriptionValidation = data.description ? validateGroupDescription(data.description) : right(null)

    if (isLeft(nameValidation)) {
      return nameValidation
    }

    if (isLeft(descriptionValidation)) {
      return descriptionValidation
    }

    if (data.createdAt > data.updatedAt) {
      return left("update_before_create")
    }

    return right({...data, name: nameValidation.right, description: descriptionValidation.right})
  }
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
