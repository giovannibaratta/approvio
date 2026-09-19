import {
  RoleTemplate,
  RoleValidationError,
  UserValidationError,
  AgentValidationError,
  AuditLogValidationError
} from "@domain"
import {AuthorizationError, UnknownError} from "@services/error"
import {UserUpdateError} from "@services/user"
import {AgentUpdateError} from "@services/agent"
import {ExecutionError} from "@services/transaction/interfaces"
import {TenantOperationError} from "../tenancy/interfaces"

export type ListRoleTemplatesError = "unknown_error"
export type ListRoleTemplatesResult = ReadonlyArray<RoleTemplate>

export type UserRoleAssignmentError =
  | TenantOperationError
  | "user_not_found"
  | "workflow_template_not_found"
  | RoleValidationError
  | UserValidationError
  | UserUpdateError
  | AuthorizationError
  | UnknownError
  | ExecutionError
  | "quota_exceeded"
  | "quota_check_error"
  | AuditLogValidationError

export type AgentRoleAssignmentError =
  | TenantOperationError
  | "agent_not_found"
  | "workflow_template_not_found"
  | RoleValidationError
  | AgentValidationError
  | AgentUpdateError
  | AuthorizationError
  | UnknownError
  | AuditLogValidationError
  | ExecutionError

export type UserRoleRemovalError =
  | TenantOperationError
  | "user_not_found"
  | "workflow_template_not_found"
  | RoleValidationError
  | UserValidationError
  | UserUpdateError
  | AuthorizationError
  | UnknownError
  | AuditLogValidationError
  | ExecutionError

export type AgentRoleRemovalError =
  | TenantOperationError
  | "agent_not_found"
  | "workflow_template_not_found"
  | RoleValidationError
  | AgentValidationError
  | AgentUpdateError
  | AuthorizationError
  | UnknownError
  | AuditLogValidationError
  | ExecutionError
