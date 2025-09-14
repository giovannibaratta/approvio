import {Space, SpaceValidationError, User} from "@domain"
import {RequestorAwareRequest} from "@services/shared/types"
import {Versioned} from "@domain"
import {TaskEither} from "fp-ts/lib/TaskEither"

// Repository interfaces
export const SPACE_REPOSITORY_TOKEN = "SPACE_REPOSITORY_TOKEN"

export interface SpaceRepository {
  createSpaceWithUserPermissions(data: CreateSpaceWithUserPermissionsRepo): TaskEither<CreateSpaceRepoError, Space>
  getSpaceById(data: GetSpaceByIdRepo): TaskEither<GetSpaceRepoError, Versioned<Space>>
  getSpaceByName(data: GetSpaceByNameRepo): TaskEither<GetSpaceRepoError, Versioned<Space>>
  listSpaces(data: ListSpacesRepo): TaskEither<ListSpacesRepoError, ListSpacesResult>
  deleteSpace(data: DeleteSpaceRepo): TaskEither<DeleteSpaceRepoError, void>
}

// Repository data types
export interface CreateSpaceWithUserPermissionsRepo {
  space: Space
  user: User
  userOcc: bigint
}

export interface GetSpaceByIdRepo {
  spaceId: string
}

export interface GetSpaceByNameRepo {
  spaceName: string
}

export interface ListSpacesRepo {
  page: number
  limit: number
}

export interface DeleteSpaceRepo {
  spaceId: string
}

export interface ListSpacesResult {
  spaces: ReadonlyArray<Versioned<Space>>
  total: number
  page: number
  limit: number
}

// Repository error types
export type CreateSpaceRepoError = "space_already_exists" | "concurrency_error" | "unknown_error" | SpaceValidationError
export type GetSpaceRepoError = "space_not_found" | "unknown_error" | SpaceValidationError
export type ListSpacesRepoError = "invalid_page" | "invalid_limit" | "unknown_error" | SpaceValidationError
export type DeleteSpaceRepoError = "space_not_found" | "unknown_error"

// Service request types
export interface CreateSpaceRequest extends RequestorAwareRequest {
  spaceData: Omit<Space, "id" | "createdAt" | "updatedAt">
}

export interface GetSpaceRequest extends RequestorAwareRequest {
  spaceId: string
}

export interface ListSpacesRequest extends RequestorAwareRequest {
  page?: number
  limit?: number
}

export interface DeleteSpaceRequest extends RequestorAwareRequest {
  spaceId: string
}
