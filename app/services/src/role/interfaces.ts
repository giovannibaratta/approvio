import {RoleTemplate, RoleValidationError, UserValidationError, AgentValidationError} from "@domain"
import {AuthorizationError, UnknownError} from "@services/error"
import {UserUpdateError} from "@services/user"
import {AgentUpdateError} from "@services/agent"

export type ListRoleTemplatesError = "unknown_error"
export type ListRoleTemplatesResult = ReadonlyArray<RoleTemplate>

export type UserRoleAssignmentError =
  | "user_not_found"
  | RoleValidationError
  | UserValidationError
  | UserUpdateError
  | AuthorizationError
  | UnknownError

export type AgentRoleAssignmentError =
  | "agent_not_found"
  | RoleValidationError
  | AgentValidationError
  | AgentUpdateError
  | AuthorizationError
  | UnknownError
