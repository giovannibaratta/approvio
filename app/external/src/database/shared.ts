import {
  Group,
  GroupFactory,
  GroupValidationError,
  GroupWithEntitiesCount,
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
  WorkflowDecoratorSelector
} from "@domain"
import {
  Group as PrismaGroup,
  User as PrismaUser,
  Workflow as PrismaWorkflow,
  WorkflowTemplate as PrismaWorkflowTemplate
} from "@prisma/client"
import {Versioned} from "@services/shared/utils"
import * as E from "fp-ts/lib/Either"
import {Either} from "fp-ts/lib/Either"
import {pipe} from "fp-ts/lib/function"
import {PrismaGroupWithCount} from "./group.repository"
import {Prisma} from "@prisma/client"
import {UserSummaryRepo} from "./user.repository"
import {UserSummaryValidationError} from "@domain"
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
    entitiesCount: dbObject._count.groupMemberships
  }

  return pipe(
    object,
    GroupFactory.validate,
    E.map(group => ({...group, occ: dbObject.occ}))
  )
}

export function mapToDomainVersionedUser(dbObject: PrismaUser): Either<UserValidationError, Versioned<User>> {
  return pipe(
    dbObject,
    mapUserToDomain,
    E.map(user => ({...user, occ: dbObject.occ}))
  )
}

export function mapUserToDomain(dbObject: PrismaUser): Either<UserValidationError, User> {
  const object = {
    id: dbObject.id,
    displayName: dbObject.displayName,
    email: dbObject.email,
    createdAt: dbObject.createdAt,
    orgRole: dbObject.orgRole
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

function prismaJsonToJson(prismaJson: Prisma.JsonValue): Either<"malformed_content", JSON> {
  if (prismaJson === null) return E.left("malformed_content")
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

  const object = {
    createdAt: dbObject.createdAt,
    description: dbObject.description ?? undefined,
    id: dbObject.id,
    name: dbObject.name,
    updatedAt: dbObject.updatedAt,
    approvalRule: eitherApprovalRule.right,
    actions: eitherActions.right,
    defaultExpiresInHours: dbObject.defaultExpiresInHours ?? undefined,
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
