import {User, Agent, AuthenticatedEntity} from "@domain"
import {AuthorizationError} from "@services/error"
import * as E from "fp-ts/Either"

export interface RequestorAwareRequest {
  requestor: AuthenticatedEntity
}

export function validateUserEntity(entity: AuthenticatedEntity): E.Either<AuthorizationError, User> {
  return entity.entityType === "user" ? E.right(entity.user) : E.left("requestor_not_authorized")
}

export function validateAgentEntity(entity: AuthenticatedEntity): E.Either<AuthorizationError, Agent> {
  return entity.entityType === "agent" ? E.right(entity.agent) : E.left("requestor_not_authorized")
}
