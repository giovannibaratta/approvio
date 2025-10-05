import {
  SystemRole,
  RoleFactory,
  UserFactory,
  AgentFactory,
  BoundRole,
  RoleScope,
  AuthenticatedEntity,
  RoleAuthorizationChecker,
  User,
  MAX_ROLES_PER_ENTITY
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {
  ListRoleTemplatesError,
  ListRoleTemplatesResult,
  UserRoleAssignmentError,
  AgentRoleAssignmentError
} from "./interfaces"
import {validateUserEntity} from "@services/shared/types"
import {AGENT_REPOSITORY_TOKEN, AgentRepository} from "@services/agent"
import {USER_REPOSITORY_TOKEN, UserRepository} from "@services/user"

@Injectable()
export class RoleService {
  constructor(
    @Inject(USER_REPOSITORY_TOKEN)
    private readonly userRoleRepo: UserRepository,
    @Inject(AGENT_REPOSITORY_TOKEN)
    private readonly agentRoleRepo: AgentRepository
  ) {}

  /**
   * Lists all predefined role templates available in the system.
   * This is a read-only operation that returns hardcoded role templates.
   */
  listRoleTemplates(): TaskEither<ListRoleTemplatesError, ListRoleTemplatesResult> {
    return TE.right(SystemRole.getAllSystemRoleTemplates())
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
        return `${roleName}:workflow_template:${scope.workflowTemplateId}`
    }
  }

  /**
   * Assigns roles to a user (additive operation)
   */
  assignRolesToUser(request: AssignRolesToUserRequest): TaskEither<UserRoleAssignmentError, void> {
    const validateAndCreateBoundRoles = (items: RoleAssignmentItem[]) =>
      pipe(
        this.generateBoundRoles<UserRoleAssignmentError>(items),
        E.chainW(boundRoles => RoleFactory.validateRolesForEntityType(boundRoles, "user"))
      )

    const validateRequestorAsPermissions = (req: AssignRolesToUserRequest, boundRoles: ReadonlyArray<BoundRole>) => {
      return pipe(
        validateUserEntity(req.requestor),
        E.chainW(user =>
          E.fromPredicate(
            (u: User) => RoleAuthorizationChecker.canAssignRoles(u, boundRoles),
            () => "requestor_not_authorized" as const
          )(user)
        )
      )
    }

    return pipe(
      TE.Do,
      TE.bindW("request", () => TE.right(request)),
      TE.bindW("boundRolesToAssign", ({request}) => TE.fromEither(validateAndCreateBoundRoles(request.roles))),
      TE.chainFirstEitherKW(({request, boundRolesToAssign}) =>
        validateRequestorAsPermissions(request, boundRolesToAssign)
      ),
      TE.bindW("currentUser", ({request}) => this.userRoleRepo.getUserById(request.userId)),
      TE.chainEitherKW(({currentUser, boundRolesToAssign}) => UserFactory.assignRoles(currentUser, boundRolesToAssign)),
      TE.chainW(updatedUser => this.userRoleRepo.updateUser(updatedUser)),
      TE.map(() => undefined)
    )
  }

  /**
   * Assigns roles to an agent (additive operation, workflow permissions only)
   */
  assignRolesToAgent(request: AssignRolesToAgentRequest): TaskEither<AgentRoleAssignmentError, void> {
    const validateAndCreateBoundRoles = (items: RoleAssignmentItem[]) =>
      pipe(
        this.generateBoundRoles<AgentRoleAssignmentError>(items),
        E.chainW(boundRoles => RoleFactory.validateRolesForEntityType(boundRoles, "agent"))
      )

    const validateRequestorAsPermissions = (req: AssignRolesToAgentRequest, boundRoles: ReadonlyArray<BoundRole>) => {
      return pipe(
        validateUserEntity(req.requestor),
        E.chainW(user =>
          E.fromPredicate(
            (u: User) => RoleAuthorizationChecker.canAssignRoles(u, boundRoles),
            () => "requestor_not_authorized" as const
          )(user)
        )
      )
    }

    return pipe(
      TE.Do,
      TE.bindW("request", () => TE.right(request)),
      TE.bindW("boundRolesToAssign", ({request}) => TE.fromEither(validateAndCreateBoundRoles(request.roles))),
      TE.chainFirstEitherKW(({request, boundRolesToAssign}) =>
        validateRequestorAsPermissions(request, boundRolesToAssign)
      ),
      TE.bindW("currentAgent", ({request}) => this.agentRoleRepo.getAgentById(request.agentId)),
      TE.chainEitherKW(({currentAgent, boundRolesToAssign}) =>
        AgentFactory.assignRoles<{occ: true}>(currentAgent, boundRolesToAssign)
      ),
      TE.chainW(updatedAgent => this.agentRoleRepo.updateAgent(updatedAgent)),
      TE.map(() => undefined)
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
}

export interface AssignRolesToAgentRequest {
  readonly agentId: string
  readonly roles: RoleAssignmentItem[]
  readonly requestor: AuthenticatedEntity
}
