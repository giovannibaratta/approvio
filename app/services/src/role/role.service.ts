import {
  SystemRole,
  RoleFactory,
  UserFactory,
  AgentFactory,
  BoundRole,
  RoleScope,
  WorkflowTemplateScope,
  AuthenticatedEntity,
  RoleAuthorizationChecker,
  User,
  MAX_ROLES_PER_ENTITY,
  AuditLogFactory,
  CreateAuditLog,
  AuditLogValidationError,
  TenantContext,
  BoundaryError
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {logSuccess} from "@utils"
import {
  ListRoleTemplatesError,
  ListRoleTemplatesResult,
  UserRoleAssignmentError,
  AgentRoleAssignmentError,
  UserRoleRemovalError,
  AgentRoleRemovalError
} from "./interfaces"
import {validateUserEntity} from "@services/shared/types"
import {TenantTransactionManager, TRANSACTION_MANAGER_TOKEN, ExecutionError} from "@services/transaction/interfaces"
import {AuditLogRepository, AUDIT_LOG_REPOSITORY_TOKEN} from "@services/audit-log/interfaces"
import {extractActorDetails} from "@services/shared/actor-extractor"
import {AGENT_REPOSITORY_TOKEN, AgentRepository} from "@services/agent"
import {USER_REPOSITORY_TOKEN, UserRepository} from "@services/user"
import {WORKFLOW_TEMPLATE_REPOSITORY_TOKEN, WorkflowTemplateRepository} from "@services/workflow-template"
import {QuotaService} from "@services/quota/quota.service"

@Injectable()
export class RoleService {
  constructor(
    @Inject(USER_REPOSITORY_TOKEN)
    private readonly userRoleRepo: UserRepository,
    @Inject(AGENT_REPOSITORY_TOKEN)
    private readonly agentRoleRepo: AgentRepository,
    @Inject(WORKFLOW_TEMPLATE_REPOSITORY_TOKEN)
    private readonly workflowTemplateRepo: WorkflowTemplateRepository,
    private readonly quotaService: QuotaService,
    @Inject(TRANSACTION_MANAGER_TOKEN)
    private readonly txManager: TenantTransactionManager,
    @Inject(AUDIT_LOG_REPOSITORY_TOKEN)
    private readonly auditLogRepo: AuditLogRepository
  ) {}

  /**
   * Lists all predefined role templates available in the system.
   * This is a read-only operation that returns hardcoded role templates.
   */
  listRoleTemplates(): TaskEither<ListRoleTemplatesError, ListRoleTemplatesResult> {
    return pipe(
      TE.right(SystemRole.getAllSystemRoleTemplates()),
      logSuccess("Role templates listed", "RoleService", result => ({count: result.length}))
    )
  }

  /**
   * Resolves role assignment items to bound roles
   */
  private generateBoundRoles<T extends UserRoleAssignmentError | AgentRoleAssignmentError>(
    items: RoleAssignmentItem[]
  ): E.Either<T, ReadonlyArray<BoundRole>> {
    if (items.length === 0) return E.left("role_assignments_empty" as T)
    if (items.length > MAX_ROLES_PER_ENTITY) return E.left("role_assignments_exceed_maximum" as T)

    const validatedRoles: BoundRole[] = []
    const seenRoles = new Set<string>()

    for (const item of items) {
      // Create composite key for deduplication
      const roleKey = this.createRoleKey(item.roleName, item.scope)

      if (seenRoles.has(roleKey)) continue // Skip duplicates (consolidation)

      seenRoles.add(roleKey)

      const boundRoleResult = pipe(
        SystemRole.findRoleTemplate(item.roleName),
        E.chainFirstW(template => RoleFactory.validateScopeForTemplate(item.scope, template)),
        E.map(template => ({...template, scope: item.scope}))
      )

      if (E.isLeft(boundRoleResult)) return E.left(boundRoleResult.left as T)
      const boundRole = boundRoleResult.right

      validatedRoles.push(boundRole)
    }

    return E.right(validatedRoles)
  }

  /**
   * Creates a composite key for role deduplication
   */
  private createRoleKey(roleName: string, scope: RoleScope): string {
    switch (scope.type) {
      case "org":
        return `${roleName}:org`
      case "space":
        return `${roleName}:space:${scope.spaceId}`
      case "group":
        return `${roleName}:group:${scope.groupId}`
      case "workflow_template":
        return `${roleName}:workflow_template:${scope.templateName}`
    }
  }

  /**
   * Type guard to narrow BoundRole to workflow template scoped roles
   */
  private isWorkflowTemplateRole(role: BoundRole): role is BoundRole & {scope: WorkflowTemplateScope} {
    return role.scope.type === "workflow_template"
  }

  /**
   * Fetches workflow template to space ID mappings for roles that require it
   */
  private fetchWorkflowTemplateSpaceMappings(
    context: TenantContext,
    boundRoles: ReadonlyArray<BoundRole>
  ): TaskEither<BoundaryError | "workflow_template_not_found", ReadonlyMap<string, string>> {
    const workflowTemplateNames = boundRoles
      .filter(role => this.isWorkflowTemplateRole(role))
      .map(role => role.scope.templateName)

    return this.workflowTemplateRepo.getWorkflowTemplatesParentsByNames(context, workflowTemplateNames)
  }

  /**
   * Assigns roles to a user (additive operation)
   */
  assignRolesToUser(request: AssignRolesToUserRequest): TaskEither<UserRoleAssignmentError, {updatedOcc: bigint}> {
    const validateAndCreateBoundRoles = (items: RoleAssignmentItem[]) =>
      pipe(
        this.generateBoundRoles<UserRoleAssignmentError>(items),
        E.chainW(boundRoles => RoleFactory.validateRolesForEntityType(boundRoles, "user"))
      )

    const validateRequestorAsPermissions = (
      req: AssignRolesToUserRequest,
      boundRoles: ReadonlyArray<BoundRole>,
      workflowTemplatesParents: ReadonlyMap<string, string>
    ) => {
      return pipe(
        validateUserEntity(req.requestor),
        E.chainW(user =>
          E.fromPredicate(
            (u: User) => RoleAuthorizationChecker.canAssignRoles(u, boundRoles, workflowTemplatesParents),
            () => "requestor_not_authorized" as const
          )(user)
        )
      )
    }

    const checkQuota = (targetUser: User, updatedUser: User) => {
      const addedRolesCount = updatedUser.roles.length - targetUser.roles.length
      return pipe(
        this.quotaService.isQuotaAvailable(
          {type: "User", identifier: targetUser.id},
          "MAX_ROLES_PER_USER",
          request.context,
          addedRolesCount
        ),
        TE.mapLeft(() => "quota_check_error" as const),
        TE.chainW(isAvailable => (isAvailable ? TE.right(undefined) : TE.left("quota_exceeded" as const)))
      )
    }

    return this.txManager.execute<UserRoleAssignmentError, {updatedOcc: bigint}>(request.context, () =>
      pipe(
        TE.Do,
        TE.bindW("request", () => TE.right(request)),
        TE.bindW("boundRolesToAssign", ({request}) => TE.fromEither(validateAndCreateBoundRoles(request.roles))),
        TE.bindW("workflowTemplatesParents", ({boundRolesToAssign, request}) =>
          this.fetchWorkflowTemplateSpaceMappings(request.context, boundRolesToAssign)
        ),
        TE.chainFirstEitherKW(({request, boundRolesToAssign, workflowTemplatesParents}) =>
          validateRequestorAsPermissions(request, boundRolesToAssign, workflowTemplatesParents)
        ),
        TE.bindW("targetUser", ({request}) => this.userRoleRepo.getUserById(request.context, request.userId)),
        TE.chainFirstW(({targetUser, request}) =>
          targetUser.occ === request.occVersion
            ? TE.right(undefined)
            : TE.left("concurrent_modification_error" as const)
        ),
        TE.bindW("newRolesOnly", ({targetUser, boundRolesToAssign}) =>
          TE.right(
            boundRolesToAssign.filter(
              role =>
                !targetUser.roles.some(
                  existing => existing.name === role.name && RoleFactory.isSameScope(existing.scope, role.scope)
                )
            )
          )
        ),
        TE.bindW("updatedUser", ({targetUser, boundRolesToAssign}) =>
          TE.fromEither(UserFactory.assignRoles(targetUser, boundRolesToAssign))
        ),
        TE.chainFirstW(({targetUser, updatedUser}) => checkQuota(targetUser, updatedUser)),
        TE.bindW("actor", ({request}) => TE.right(extractActorDetails(request.requestor))),
        TE.bindW("persistedUser", ({updatedUser, actor, newRolesOnly}) =>
          pipe(
            this.userRoleRepo.updateUser(request.context, updatedUser),
            TE.chainFirstW(() =>
              this.persistUserRolesAuditLog(request.context, "USER_ROLES_ASSIGNED", request.userId, actor, newRolesOnly)
            )
          )
        ),
        TE.map(({persistedUser}) => ({updatedOcc: persistedUser.occ})),
        logSuccess("Roles assigned to user", "RoleService", () => ({userId: request.userId}))
      )
    )
  }

  /**
   * Assigns roles to an agent (additive operation, workflow permissions only)
   */
  assignRolesToAgent(request: AssignRolesToAgentRequest): TaskEither<AgentRoleAssignmentError, bigint> {
    const validateAndCreateBoundRoles = (items: RoleAssignmentItem[]) =>
      pipe(
        this.generateBoundRoles<AgentRoleAssignmentError>(items),
        E.chainW(boundRoles => RoleFactory.validateRolesForEntityType(boundRoles, "agent"))
      )

    const validateRequestorAsPermissions = (
      req: AssignRolesToAgentRequest,
      boundRoles: ReadonlyArray<BoundRole>,
      workflowTemplatesParents: ReadonlyMap<string, string>
    ) => {
      return pipe(
        validateUserEntity(req.requestor),
        E.chainW(user =>
          E.fromPredicate(
            (u: User) => RoleAuthorizationChecker.canAssignRoles(u, boundRoles, workflowTemplatesParents),
            () => "requestor_not_authorized" as const
          )(user)
        )
      )
    }

    return this.txManager.execute<AgentRoleAssignmentError, bigint>(request.context, () =>
      pipe(
        TE.Do,
        TE.bindW("request", () => TE.right(request)),
        TE.bindW("boundRolesToAssign", ({request}) => TE.fromEither(validateAndCreateBoundRoles(request.roles))),
        TE.bindW("workflowTemplatesParents", ({boundRolesToAssign, request}) =>
          this.fetchWorkflowTemplateSpaceMappings(request.context, boundRolesToAssign)
        ),
        TE.chainFirstEitherKW(({request, boundRolesToAssign, workflowTemplatesParents}) =>
          validateRequestorAsPermissions(request, boundRolesToAssign, workflowTemplatesParents)
        ),
        TE.bindW("currentAgent", ({request}) => this.agentRoleRepo.getAgentById(request.context, request.agentId)),
        TE.chainFirstW(({currentAgent, request}) =>
          currentAgent.occ === request.occVersion
            ? TE.right(undefined)
            : TE.left("concurrent_modification_error" as const)
        ),
        TE.bindW("newRolesOnly", ({currentAgent, boundRolesToAssign}) =>
          TE.right(
            boundRolesToAssign.filter(
              role =>
                !currentAgent.roles.some(
                  existing => existing.name === role.name && RoleFactory.isSameScope(existing.scope, role.scope)
                )
            )
          )
        ),
        TE.bindW("updatedAgent", ({currentAgent, boundRolesToAssign}) =>
          TE.fromEither(AgentFactory.assignRoles<{occ: true}>(currentAgent, boundRolesToAssign))
        ),
        TE.bindW("actor", ({request}) => TE.right(extractActorDetails(request.requestor))),
        TE.bindW("persistedAgent", ({updatedAgent, actor, newRolesOnly}) =>
          pipe(
            this.agentRoleRepo.updateAgent(request.context, updatedAgent),
            TE.chainFirstW(() =>
              this.persistAgentRolesAuditLog(
                request.context,
                "AGENT_ROLES_ASSIGNED",
                request.agentId,
                actor,
                newRolesOnly
              )
            )
          )
        ),
        TE.map(({persistedAgent}) => persistedAgent.occ),
        logSuccess("Roles assigned to agent", "RoleService", () => ({agentId: request.agentId}))
      )
    )
  }

  /**
   * Removes roles from a user
   */
  removeRolesFromUser(request: RemoveRolesFromUserRequest): TaskEither<UserRoleRemovalError, {updatedOcc: bigint}> {
    const validateAndCreateBoundRoles = (items: RoleAssignmentItem[]) =>
      pipe(
        this.generateBoundRoles<UserRoleRemovalError>(items),
        E.chainW(boundRoles => RoleFactory.validateRolesForEntityType(boundRoles, "user"))
      )

    const validateRequestorAsPermissions = (
      req: RemoveRolesFromUserRequest,
      boundRoles: ReadonlyArray<BoundRole>,
      workflowTemplatesParents: ReadonlyMap<string, string>
    ) => {
      return pipe(
        validateUserEntity(req.requestor),
        E.chainW(user =>
          E.fromPredicate(
            (u: User) => RoleAuthorizationChecker.canAssignRoles(u, boundRoles, workflowTemplatesParents),
            () => "requestor_not_authorized" as const
          )(user)
        )
      )
    }

    return this.txManager.execute<UserRoleRemovalError, {updatedOcc: bigint}>(request.context, () =>
      pipe(
        TE.Do,
        TE.bindW("request", () => TE.right(request)),
        TE.bindW("boundRolesToRemove", ({request}) => TE.fromEither(validateAndCreateBoundRoles(request.roles))),
        TE.bindW("workflowTemplatesParents", ({boundRolesToRemove, request}) =>
          this.fetchWorkflowTemplateSpaceMappings(request.context, boundRolesToRemove)
        ),
        TE.chainFirstEitherKW(({request, boundRolesToRemove, workflowTemplatesParents}) =>
          validateRequestorAsPermissions(request, boundRolesToRemove, workflowTemplatesParents)
        ),
        TE.bindW("targetUser", ({request}) => this.userRoleRepo.getUserById(request.context, request.userId)),
        TE.chainFirstW(({targetUser, request}) =>
          targetUser.occ === request.occVersion
            ? TE.right(undefined)
            : TE.left("concurrent_modification_error" as const)
        ),
        TE.bindW("removedRolesOnly", ({targetUser, boundRolesToRemove}) =>
          TE.right(
            boundRolesToRemove.filter(role =>
              targetUser.roles.some(
                existing => existing.name === role.name && RoleFactory.isSameScope(existing.scope, role.scope)
              )
            )
          )
        ),
        TE.bindW("updatedUser", ({targetUser, boundRolesToRemove}) =>
          TE.fromEither(UserFactory.removeRoles(targetUser, boundRolesToRemove))
        ),
        TE.bindW("actor", ({request}) => TE.right(extractActorDetails(request.requestor))),
        TE.bindW("persistedUser", ({updatedUser, actor, removedRolesOnly}) =>
          pipe(
            this.userRoleRepo.updateUser(request.context, updatedUser),
            TE.chainFirstW(() =>
              this.persistUserRolesAuditLog(
                request.context,
                "USER_ROLES_REMOVED",
                request.userId,
                actor,
                removedRolesOnly
              )
            )
          )
        ),
        TE.map(({persistedUser}) => ({updatedOcc: persistedUser.occ})),
        logSuccess("Roles removed from user", "RoleService", () => ({userId: request.userId}))
      )
    )
  }

  /**
   * Removes roles from an agent
   */
  removeRolesFromAgent(request: RemoveRolesFromAgentRequest): TaskEither<AgentRoleRemovalError, bigint> {
    const validateAndCreateBoundRoles = (items: RoleAssignmentItem[]) =>
      pipe(
        this.generateBoundRoles<AgentRoleRemovalError>(items),
        E.chainW(boundRoles => RoleFactory.validateRolesForEntityType(boundRoles, "agent"))
      )

    const validateRequestorAsPermissions = (
      req: RemoveRolesFromAgentRequest,
      boundRoles: ReadonlyArray<BoundRole>,
      workflowTemplatesParents: ReadonlyMap<string, string>
    ) => {
      return pipe(
        validateUserEntity(req.requestor),
        E.chainW(user =>
          E.fromPredicate(
            (u: User) => RoleAuthorizationChecker.canAssignRoles(u, boundRoles, workflowTemplatesParents),
            () => "requestor_not_authorized" as const
          )(user)
        )
      )
    }

    return this.txManager.execute<AgentRoleRemovalError, bigint>(request.context, () =>
      pipe(
        TE.Do,
        TE.bindW("request", () => TE.right(request)),
        TE.bindW("boundRolesToRemove", ({request}) => TE.fromEither(validateAndCreateBoundRoles(request.roles))),
        TE.bindW("workflowTemplatesParents", ({boundRolesToRemove, request}) =>
          this.fetchWorkflowTemplateSpaceMappings(request.context, boundRolesToRemove)
        ),
        TE.chainFirstEitherKW(({request, boundRolesToRemove, workflowTemplatesParents}) =>
          validateRequestorAsPermissions(request, boundRolesToRemove, workflowTemplatesParents)
        ),
        TE.bindW("currentAgent", ({request}) => this.agentRoleRepo.getAgentById(request.context, request.agentId)),
        TE.chainFirstW(({currentAgent, request}) =>
          currentAgent.occ === request.occVersion
            ? TE.right(undefined)
            : TE.left("concurrent_modification_error" as const)
        ),
        TE.bindW("removedRolesOnly", ({currentAgent, boundRolesToRemove}) =>
          TE.right(
            boundRolesToRemove.filter(role =>
              currentAgent.roles.some(
                existing => existing.name === role.name && RoleFactory.isSameScope(existing.scope, role.scope)
              )
            )
          )
        ),
        TE.bindW("updatedAgent", ({currentAgent, boundRolesToRemove}) =>
          TE.fromEither(AgentFactory.removeRoles<{occ: true}>(currentAgent, boundRolesToRemove))
        ),
        TE.bindW("actor", ({request}) => TE.right(extractActorDetails(request.requestor))),
        TE.bindW("persistedAgent", ({updatedAgent, actor, removedRolesOnly}) =>
          pipe(
            this.agentRoleRepo.updateAgent(request.context, updatedAgent),
            TE.chainFirstW(() =>
              this.persistAgentRolesAuditLog(
                request.context,
                "AGENT_ROLES_REMOVED",
                request.agentId,
                actor,
                removedRolesOnly
              )
            )
          )
        ),
        TE.map(({persistedAgent}) => persistedAgent.occ),
        logSuccess("Roles removed from agent", "RoleService", () => ({agentId: request.agentId}))
      )
    )
  }

  /**
   * Persists an audit log for user role changes
   */
  private persistUserRolesAuditLog(
    context: TenantContext,
    auditType: "USER_ROLES_ASSIGNED" | "USER_ROLES_REMOVED",
    userId: string,
    actor: CreateAuditLog["actor"],
    roles: ReadonlyArray<BoundRole>
  ): TaskEither<AuditLogValidationError | ExecutionError | BoundaryError | "unknown_error", void> {
    return pipe(
      AuditLogFactory.create({
        organizationId: context.organizationId,
        auditType,
        entityType: "USER",
        entityId: userId,
        actor,
        payload: {
          roles: roles.map(r => ({
            roleName: r.name,
            scope: r.scope
          }))
        }
      }),
      TE.fromEither,
      TE.chainW(auditLog => this.auditLogRepo.persist(context, auditLog))
    )
  }

  /**
   * Persists an audit log for agent role changes
   */
  private persistAgentRolesAuditLog(
    context: TenantContext,
    auditType: "AGENT_ROLES_ASSIGNED" | "AGENT_ROLES_REMOVED",
    agentId: string,
    actor: CreateAuditLog["actor"],
    roles: ReadonlyArray<BoundRole>
  ): TaskEither<AuditLogValidationError | ExecutionError | BoundaryError | "unknown_error", void> {
    return pipe(
      AuditLogFactory.create({
        organizationId: context.organizationId,
        auditType,
        entityType: "AGENT",
        entityId: agentId,
        actor,
        payload: {
          roles: roles.map(r => ({
            roleName: r.name,
            scope: r.scope
          }))
        }
      }),
      TE.fromEither,
      TE.chainW(auditLog => this.auditLogRepo.persist(context, auditLog))
    )
  }
}

export interface RoleAssignmentItem {
  readonly roleName: string
  readonly scope: RoleScope
}

export interface AssignRolesToUserRequest {
  readonly userId: string
  readonly roles: RoleAssignmentItem[]
  readonly requestor: AuthenticatedEntity
  readonly context: TenantContext
  readonly occVersion: bigint
}

export interface AssignRolesToAgentRequest {
  readonly agentId: string
  readonly roles: RoleAssignmentItem[]
  readonly requestor: AuthenticatedEntity
  readonly context: TenantContext
  readonly occVersion: bigint
}

export interface RemoveRolesFromUserRequest {
  readonly userId: string
  readonly roles: RoleAssignmentItem[]
  readonly requestor: AuthenticatedEntity
  readonly context: TenantContext
  readonly occVersion: bigint
}

export interface RemoveRolesFromAgentRequest {
  readonly agentId: string
  readonly roles: RoleAssignmentItem[]
  readonly requestor: AuthenticatedEntity
  readonly context: TenantContext
  readonly occVersion: bigint
}
