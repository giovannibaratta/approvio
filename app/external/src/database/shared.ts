import {
  Agent,
  Group,
  GroupFactory,
  GroupValidationError,
  GroupWithEntitiesCount,
  OrganizationAdmin,
  OrganizationAdminFactory,
  OrganizationAdminValidationError,
  Space,
  SpaceFactory,
  SpaceValidationError,
  User,
  UserFactory,
  UserSummary,
  UserValidationError,
  Workflow,
  WorkflowFactory,
  WorkflowValidationError,
  WorkflowTemplate,
  WorkflowTemplateFactory,
  WorkflowTemplateValidationError,
  DecoratedWorkflow,
  WorkflowDecoratorSelector,
  OrgRole,
  AgentFactory,
  AgentValidationError,
  UnconstrainedBoundRole
} from "@domain"
import {
  Agent as PrismaAgent,
  Group as PrismaGroup,
  OrganizationAdmin as PrismaOrganizationAdmin,
  Space as PrismaSpace,
  Workflow as PrismaWorkflow,
  WorkflowTemplate as PrismaWorkflowTemplate
} from "@prisma/client"
import {Versioned} from "@domain"
import * as E from "fp-ts/lib/Either"
import {Either} from "fp-ts/lib/Either"
import {pipe} from "fp-ts/lib/function"
import {PrismaGroupWithCount} from "./group.repository"
import {Prisma} from "@prisma/client"
import {PrismaUserWithOrgAdmin, UserSummaryRepo} from "./user.repository"
import {UserSummaryValidationError} from "@domain"
import {AgentKeyDecodeError} from "@services"
import {iPrismaDecoratedWorkflow, PrismaDecoratedWorkflow, PrismaWorkflowDecoratorSelector} from "./workflow.repository"

export type PrismaWorkflowWithTemplate = PrismaWorkflow & {
  workflowTemplates: PrismaWorkflowTemplate
}

export type PrismaWorkflowWithOptionalTemplate = PrismaWorkflow & {
  workflowTemplates?: PrismaWorkflowTemplate | null
}

export function mapToDomainVersionedGroup(dbObject: PrismaGroup): Either<GroupValidationError, Versioned<Group>> {
  const object: Group = {
    createdAt: dbObject.createdAt,
    description: dbObject.description,
    id: dbObject.id,
    name: dbObject.name,
    updatedAt: dbObject.updatedAt
  }

  return pipe(
    object,
    GroupFactory.validate,
    E.map(group => ({...group, occ: dbObject.occ}))
  )
}

export function mapToDomainVersionedGroupWithEntities(
  dbObject: PrismaGroupWithCount
): Either<GroupValidationError, Versioned<GroupWithEntitiesCount>> {
  const object: GroupWithEntitiesCount = {
    createdAt: dbObject.createdAt,
    description: dbObject.description,
    id: dbObject.id,
    name: dbObject.name,
    updatedAt: dbObject.updatedAt,
    entitiesCount: dbObject._count.groupMemberships + dbObject._count.agentGroupMemberships
  }

  return pipe(
    object,
    GroupFactory.validate,
    E.map(group => ({...group, occ: dbObject.occ}))
  )
}

export function mapToDomainVersionedUser(
  dbObject: PrismaUserWithOrgAdmin
): Either<UserValidationError, Versioned<User>> {
  return pipe(
    dbObject,
    mapUserToDomain,
    E.map(user => ({...user, occ: dbObject.occ}))
  )
}

export function mapUserToDomain(dbObject: PrismaUserWithOrgAdmin): Either<UserValidationError, User> {
  const object = {
    id: dbObject.id,
    displayName: dbObject.displayName,
    email: dbObject.email,
    createdAt: dbObject.createdAt,
    orgRole: dbObject.organizationAdmins ? OrgRole.ADMIN : OrgRole.MEMBER,
    roles: dbObject.roles
  }

  return pipe(object, UserFactory.validate)
}

export function mapWorkflowToDomain<
  DomainSelectors extends WorkflowDecoratorSelector,
  PrismaSelectors extends PrismaWorkflowDecoratorSelector
>(
  dbObject: PrismaDecoratedWorkflow<PrismaSelectors>,
  include?: PrismaSelectors
): Either<
  WorkflowValidationError | WorkflowTemplateValidationError | "unknown_error",
  DecoratedWorkflow<DomainSelectors>
> {
  if (include?.workflowTemplates === true) {
    if (iPrismaDecoratedWorkflow(dbObject, "workflowTemplates", include)) {
      const workflowWithTemplate = dbObject as PrismaWorkflowWithTemplate
      return mapToDomainVersionedWorkflowWithTemplate(workflowWithTemplate) as Either<
        WorkflowValidationError | WorkflowTemplateValidationError,
        DecoratedWorkflow<DomainSelectors>
      >
    }

    // This should never happen, but we need to handle the case where the workflow template is not found
    return E.left("unknown_error" as const)
  }

  return mapToDomainVersionedWorkflow(dbObject) as Either<WorkflowValidationError, DecoratedWorkflow<DomainSelectors>>
}

function mapWorkflowToNonVersionedDomain(dbObject: PrismaWorkflow): Either<WorkflowValidationError, Workflow> {
  const object = {
    createdAt: dbObject.createdAt,
    description: dbObject.description ?? undefined,
    id: dbObject.id,
    name: dbObject.name,
    updatedAt: dbObject.updatedAt,
    status: dbObject.status,
    recalculationRequired: dbObject.recalculationRequired,
    workflowTemplateId: dbObject.workflowTemplateId,
    expiresAt: dbObject.expiresAt,
    occ: dbObject.occ
  }
  return pipe(object, WorkflowFactory.validate)
}

export function mapToDomainVersionedWorkflow(
  dbObject: PrismaWorkflow
): Either<WorkflowValidationError, Versioned<Workflow>> {
  return pipe(
    dbObject,
    mapWorkflowToNonVersionedDomain,
    E.map(domainObject => ({
      ...domainObject,
      occ: dbObject.occ
    }))
  )
}

export function mapToDomainVersionedWorkflowWithTemplate(
  dbObject: PrismaWorkflowWithTemplate
): Either<
  WorkflowValidationError | WorkflowTemplateValidationError,
  Versioned<Workflow> & {workflowTemplate: WorkflowTemplate}
> {
  return pipe(
    E.Do,
    E.bindW("workflow", () => mapWorkflowToNonVersionedDomain(dbObject)),
    E.bindW("workflowTemplate", () => mapWorkflowTemplateToDomain(dbObject.workflowTemplates)),
    E.map(({workflow, workflowTemplate}) => ({
      ...workflow,
      occ: dbObject.occ,
      workflowTemplate
    }))
  )
}

function prismaJsonToJson(prismaJson: Prisma.JsonValue): Either<"approval_rule_malformed_content", JSON> {
  if (prismaJson === null) return E.left("approval_rule_malformed_content")
  return E.right(JSON.parse(JSON.stringify(prismaJson)))
}

export function mapToDomainUserSummary(dbObject: UserSummaryRepo): Either<UserSummaryValidationError, UserSummary> {
  const object: UserSummary = {
    ...dbObject
  }

  return pipe(object, UserFactory.validateUserSummary)
}

export function mapWorkflowTemplateToDomain(
  dbObject: PrismaWorkflowTemplate
): Either<WorkflowTemplateValidationError, WorkflowTemplate> {
  const eitherApprovalRule = prismaJsonToJson(dbObject.approvalRule)
  if (E.isLeft(eitherApprovalRule)) return eitherApprovalRule

  const eitherActions = prismaJsonToJson(dbObject.actions)
  if (E.isLeft(eitherActions)) return eitherActions

  const version: number | "latest" = dbObject.version === "latest" ? "latest" : parseInt(dbObject.version, 10)

  const object = {
    createdAt: dbObject.createdAt,
    description: dbObject.description ?? undefined,
    id: dbObject.id,
    name: dbObject.name,
    version,
    updatedAt: dbObject.updatedAt,
    approvalRule: eitherApprovalRule.right,
    actions: eitherActions.right,
    defaultExpiresInHours: dbObject.defaultExpiresInHours ?? undefined,
    status: dbObject.status,
    allowVotingOnDeprecatedTemplate: dbObject.allowVotingOnDeprecatedTemplate,
    spaceId: dbObject.spaceId,
    occ: dbObject.occ
  }
  return pipe(object, WorkflowTemplateFactory.validate)
}

export function mapToDomainVersionedWorkflowTemplate(
  dbObject: PrismaWorkflowTemplate
): Either<WorkflowTemplateValidationError, Versioned<WorkflowTemplate>> {
  return pipe(
    dbObject,
    mapWorkflowTemplateToDomain,
    E.map(domainObject => ({
      ...domainObject,
      occ: dbObject.occ
    }))
  )
}

export function mapOrganizationAdminToDomain(
  dbObject: PrismaOrganizationAdmin
): Either<OrganizationAdminValidationError, OrganizationAdmin> {
  const object: OrganizationAdmin = {
    id: dbObject.id,
    email: dbObject.email,
    createdAt: dbObject.createdAt
  }

  return pipe(object, OrganizationAdminFactory.validate)
}

export function mapToDomainVersionedSpace(dbObject: PrismaSpace): Either<SpaceValidationError, Versioned<Space>> {
  const object: Space = {
    createdAt: dbObject.createdAt,
    description: dbObject.description ?? undefined,
    id: dbObject.id,
    name: dbObject.name,
    updatedAt: dbObject.updatedAt
  }

  return pipe(
    object,
    SpaceFactory.validate,
    E.map(space => ({...space, occ: dbObject.occ}))
  )
}

export function mapToDomainVersionedAgent(
  dbObject: PrismaAgent
): Either<AgentKeyDecodeError | AgentValidationError, Versioned<Agent>> {
  return pipe(
    dbObject,
    mapAgentToDomain,
    E.map(agent => ({...agent, occ: dbObject.occ}))
  )
}

export function mapAgentToDomain(dbObject: PrismaAgent): Either<AgentKeyDecodeError | AgentValidationError, Agent> {
  const decodePublicKey = E.tryCatch(
    () => Buffer.from(dbObject.base64PublicKey, "base64").toString("utf8"),
    () => "agent_key_decode_error" as const
  )

  return pipe(
    decodePublicKey,
    E.map(decodedPublicKey => {
      const agent = {
        id: dbObject.id,
        agentName: dbObject.agentName,
        publicKey: decodedPublicKey,
        createdAt: dbObject.createdAt,
        roles: dbObject.roles
      }
      return agent
    }),
    E.chainW(agentToValidate => AgentFactory.validate(agentToValidate))
  )
}

export class ConcurrentUpdateError extends Error {
  constructor() {
    super("Concurrent update error")
    this.name = "ConcurrentUpdateError"
  }
}

export function mapRolesToPrisma(roles: Iterable<UnconstrainedBoundRole>): Prisma.JsonArray {
  return [...roles].map(role => mapRoleToPrisma(role))
}

function mapRoleToPrisma(role: UnconstrainedBoundRole): Prisma.JsonObject {
  return {
    name: role.name,
    resourceType: role.resourceType,
    permissions: [...role.permissions],
    scopeType: role.scopeType,
    scope: mapScopeToPrisma(role.scope)
  }
}

function mapScopeToPrisma(scope: UnconstrainedBoundRole["scope"]): Prisma.JsonObject {
  switch (scope.type) {
    case "group":
      return {
        type: scope.type,
        groupId: scope.groupId
      }
    case "space":
      return {
        type: scope.type,
        spaceId: scope.spaceId
      }
    case "workflow_template":
      return {
        type: scope.type,
        workflowTemplateId: scope.workflowTemplateId
      }
    case "org":
      return {
        type: scope.type
      }
  }
}
