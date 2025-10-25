import {ApprovalRuleData, ApprovalRuleType} from "@domain"
import {
  ApprovalRule as ApprovalRuleApi,
  RoleAssignmentItem,
  RoleAssignmentRequest,
  RoleRemovalRequest,
  RoleScope,
  SpaceScope,
  OrgScope,
  GroupScope,
  WorkflowTemplateScope,
  RoleOperationRequest
} from "@approvio/api"
import {Either, right, left, chain} from "fp-ts/Either"
import * as E from "fp-ts/Either"
import * as A from "fp-ts/Array"
import {pipe} from "fp-ts/lib/function"
import {PrefixUnion, isUUIDv4} from "@utils"

/** Map the domain model to the API model */
export function mapApprovalRuleDataToApi(rule: ApprovalRuleData): ApprovalRuleApi {
  switch (rule.type) {
    case ApprovalRuleType.GROUP_REQUIREMENT:
      return {
        type: rule.type,
        groupId: rule.groupId,
        minCount: rule.minCount
      }
    case ApprovalRuleType.AND:
      return {
        type: rule.type,
        rules: rule.rules.map(mapApprovalRuleDataToApi)
      }
    case ApprovalRuleType.OR:
      return {
        type: rule.type,
        rules: rule.rules.map(mapApprovalRuleDataToApi)
      }
  }
}

type RoleOperationChangeValidationError = PrefixUnion<
  "request",
  | "malformed"
  | "roles_missing"
  | "roles_not_array"
  | "roles_empty"
  | "role_name_missing"
  | "role_name_not_string"
  | "role_name_empty"
  | "scope_missing"
  | "scope_not_object"
  | "scope_type_missing"
  | "scope_type_invalid"
  | "scope_id_missing"
  | "scope_id_invalid_uuid"
>

export type RoleAssignmentValidationError = RoleOperationChangeValidationError
export type RoleRemovalValidationError = RoleOperationChangeValidationError

/**
 * Internal validation function for role operations (assignment or removal).
 * Only performs structural validation, not semantic validation.
 */
function validateRoleOperation(request: unknown): Either<RoleOperationChangeValidationError, RoleOperationRequest> {
  return pipe(
    request,
    E.right,
    E.chainW(validateRequestStructure),
    E.chainW(validateRolesArray),
    E.map(() => request as RoleAssignmentRequest)
  )
}

/**
 * Validates the structure of a RoleAssignmentRequest from unknown input.
 * Only performs structural validation, not semantic validation.
 */
export function validateRoleAssignmentRequest(
  request: unknown
): Either<RoleAssignmentValidationError, RoleAssignmentRequest> {
  return validateRoleOperation(request)
}

/**
 * Validates the structure of a RoleRemovalRequest from unknown input.
 * Only performs structural validation, not semantic validation.
 */
export function validateRoleRemovalRequest(request: unknown): Either<RoleRemovalValidationError, RoleRemovalRequest> {
  return validateRoleOperation(request)
}

function validateRequestStructure(
  request: unknown
): Either<RoleOperationChangeValidationError, {roles: [unknown, ...unknown[]]}> {
  if (typeof request !== "object" || request === null) return left("request_malformed")
  if (!("roles" in request)) return left("request_roles_missing")
  if (!Array.isArray(request.roles)) return left("request_roles_not_array")
  if (request.roles.length === 0) return left("request_roles_empty")
  return right(request as {roles: [unknown, ...unknown[]]})
}

function validateRolesArray(request: {
  roles: [unknown, ...unknown[]]
}): Either<RoleOperationChangeValidationError, {roles: RoleAssignmentItem[]}> {
  return pipe(
    request.roles,
    A.traverse(E.Applicative)(role => validateSingleRole(role)),
    E.map(roles => ({roles}))
  )
}

function validateSingleRole(role: unknown): Either<RoleOperationChangeValidationError, RoleAssignmentItem> {
  return pipe(
    E.Do,
    E.bindW("structure", () => validateRoleStructure(role)),
    E.bindW("roleName", ({structure}) => validateRoleName(structure.roleName)),
    E.bindW("scope", ({structure}) => validateRoleScope(structure.scope)),
    E.map(({roleName, scope}) => ({roleName, scope}))
  )
}

function validateRoleStructure(
  role: unknown
): Either<RoleOperationChangeValidationError, {roleName: unknown; scope: unknown}> {
  if (typeof role !== "object" || role === null) return left("request_malformed")
  if (!("roleName" in role)) return left("request_role_name_missing")
  if (!("scope" in role)) return left("request_scope_missing")
  return right(role as {roleName: unknown; scope: unknown})
}

function validateRoleName(roleName: unknown): Either<RoleOperationChangeValidationError, string> {
  if (typeof roleName !== "string") return left("request_role_name_not_string")
  if (roleName.trim().length === 0) return left("request_role_name_empty")
  return right(roleName)
}

function validateRoleScope(scope: unknown): Either<RoleOperationChangeValidationError, RoleScope> {
  return pipe(scope, validateGenericScopeStructure, chain(validateScopeType))
}

function validateGenericScopeStructure(
  scope: unknown
): Either<RoleOperationChangeValidationError, object & {type: RoleScope["type"]}> {
  if (!scope) return left("request_scope_missing")
  if (typeof scope !== "object" || scope === null) return left("request_scope_not_object")
  if (!("type" in scope)) return left("request_scope_type_missing")
  if (typeof scope.type !== "string") return left("request_scope_type_invalid")
  if (!["org", "space", "group", "workflow_template"].includes(scope.type)) return left("request_scope_type_invalid")

  return right(scope as object & {type: RoleScope["type"]})
}

function validateScopeType(
  scope: object & {type: RoleScope["type"]}
): Either<RoleOperationChangeValidationError, RoleScope> {
  switch (scope.type) {
    case "org":
      return validateOrgScope(scope as OrgScope)
    case "space":
      return validateSpaceScope(scope as SpaceScope)
    case "group":
      return validateGroupScope(scope as GroupScope)
    case "workflow_template":
      return validateWorkflowTemplateScope(scope as WorkflowTemplateScope)
  }
}

function validateOrgScope(scope: {type: "org"}): Either<RoleOperationChangeValidationError, OrgScope> {
  return right(scope)
}

function validateSpaceScope(
  scope: {type: "space"} & Record<string, unknown>
): Either<RoleOperationChangeValidationError, SpaceScope> {
  return pipe(
    E.Do,
    E.bindW("type", () => right(scope.type)),
    E.bindW("spaceId", () => validateScopeUuidField(scope.spaceId)),
    E.map(({type, spaceId}) => ({type, spaceId}))
  )
}

function validateGroupScope(
  scope: {type: "group"} & Record<string, unknown>
): Either<RoleOperationChangeValidationError, GroupScope> {
  return pipe(
    E.Do,
    E.bindW("type", () => right(scope.type)),
    E.bindW("groupId", () => validateScopeUuidField(scope.groupId)),
    E.map(({type, groupId}) => ({type, groupId}))
  )
}

function validateWorkflowTemplateScope(
  scope: {type: "workflow_template"} & Record<string, unknown>
): Either<RoleOperationChangeValidationError, WorkflowTemplateScope> {
  return pipe(
    E.Do,
    E.bindW("type", () => right(scope.type)),
    E.bindW("workflowTemplateId", () => validateScopeUuidField(scope.workflowTemplateId)),
    E.map(({type, workflowTemplateId}) => ({type, workflowTemplateId}))
  )
}

function validateScopeUuidField(fieldValue: unknown): Either<RoleOperationChangeValidationError, string> {
  if (typeof fieldValue !== "string") return left("request_scope_id_missing")
  if (!isUUIDv4(fieldValue)) return left("request_scope_id_invalid_uuid")
  return right(fieldValue)
}
