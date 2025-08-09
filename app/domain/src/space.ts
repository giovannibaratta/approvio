import {Either, left, right, isLeft} from "fp-ts/Either"
import {randomUUID} from "crypto"
import {isUUIDv4, PrefixUnion} from "@utils"

export const SPACE_NAME_MAX_LENGTH = 255
export const SPACE_DESCRIPTION_MAX_LENGTH = 2048

export type Space = Readonly<PrivateSpace>

interface PrivateSpace {
  id: string
  name: string
  description?: string
  createdAt: Date
  updatedAt: Date
}

type NameValidationError = "name_empty" | "name_too_long" | "name_invalid_characters"
type DescriptionValidationError = "description_too_long"
type IdValidationError = "invalid_uuid"
type TimestampValidationError = "update_before_create"

export type SpaceValidationError = PrefixUnion<
  "space",
  NameValidationError | DescriptionValidationError | IdValidationError | TimestampValidationError
>

export class SpaceFactory {
  static validate(data: Space): Either<SpaceValidationError, Space> {
    return SpaceFactory.createSpace(data)
  }

  static newSpace(data: Omit<Space, "id" | "createdAt" | "updatedAt">): Either<SpaceValidationError, Space> {
    const uuid = randomUUID()
    const now = new Date()

    const space: Space = {
      ...data,
      id: uuid,
      createdAt: now,
      updatedAt: now
    }

    return SpaceFactory.validate(space)
  }

  private static createSpace(data: Space): Either<SpaceValidationError, Space> {
    const idValidation = validateId(data.id)
    const nameValidation = validateName(data.name)
    const descriptionValidation = data.description ? validateDescription(data.description) : right(undefined)

    if (isLeft(idValidation)) return idValidation
    if (isLeft(nameValidation)) return nameValidation
    if (isLeft(descriptionValidation)) return descriptionValidation
    if (data.createdAt > data.updatedAt) return left("space_update_before_create")

    return right({
      id: idValidation.right,
      name: nameValidation.right,
      description: descriptionValidation.right,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt
    })
  }
}

function validateId(id: string): Either<SpaceValidationError, string> {
  if (!isUUIDv4(id)) return left("space_invalid_uuid")
  return right(id)
}

function validateName(name: string): Either<SpaceValidationError, string> {
  if (!name || name.trim().length === 0) return left("space_name_empty")
  if (name.length > SPACE_NAME_MAX_LENGTH) return left("space_name_too_long")

  // Space names should be URL-friendly and human-readable
  // Allow letters, numbers, hyphens, underscores, and spaces
  if (!/^[a-zA-Z0-9\s_-]+$/.test(name)) {
    return left("space_name_invalid_characters")
  }

  return right(name)
}

function validateDescription(description: string): Either<SpaceValidationError, string> {
  if (description.length > SPACE_DESCRIPTION_MAX_LENGTH) return left("space_description_too_long")

  return right(description)
}
