import {
  DecoratedWorkflow,
  Workflow,
  WorkflowDecoratorSelector,
  WorkflowTemplateValidationError,
  WorkflowValidationError,
  WORKFLOW_TERMINAL_STATUSES
} from "@domain"
import {DatabaseClient} from "@external/database/database-client"
import {mapWorkflowToDomain} from "@external/database/shared"
import {chainNullableToLeft} from "@external/database/utils"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, Workflow as PrismaWorkflow, WorkflowTemplate as PrismaWorkflowTemplate} from "@prisma/client"
import {
  ConcurrentSafeWorkflowUpdateData,
  ConcurrentUnsafeWorkflowUpdateData,
  CreateWorkflowRepo,
  CreateWorkflowRepoError,
  WorkflowGetError,
  WorkflowRepository,
  WorkflowUpdateError,
  ListWorkflowsRequestRepo,
  ListWorkflowsResponse,
  UnknownError,
  WorkflowGetParentTemplateError
} from "@services"
import {TaskEither} from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {DecorableEntity, isDecoratedWith} from "@utils/types"

interface Identifier {
  type: "id" | "name"
  identifier: string
}

@Injectable()
export class WorkflowDbRepository implements WorkflowRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  /**
   * Creates a new workflow in the database.
   * @param data The workflow data to persist.
   * @returns A TaskEither with the created workflow or an error.
   */
  createWorkflow(
    data: CreateWorkflowRepo
  ): TaskEither<CreateWorkflowRepoError | WorkflowValidationError | WorkflowTemplateValidationError, Workflow> {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.persistWorkflow()),
      TE.chainEitherKW(result => mapWorkflowToDomain(result))
    )
  }

  /**
   * Gets a workflow by its UUID.
   * @param workflowId The ID of the workflow.
   * @param includeRef Include options for related data.
   * @returns A TaskEither with the workflow result or an error if not found.
   */
  getWorkflowById<T extends WorkflowDecoratorSelector>(
    workflowId: string,
    includeRef?: T
  ): TaskEither<WorkflowGetError, DecoratedWorkflow<T>> {
    const identifier: Identifier = {type: "id", identifier: workflowId}
    return this.getWorkflow(identifier, includeRef)
  }

  /**
   * Gets a workflow by its unique name.
   * @param name The name of the workflow.
   * @param includeRef Include options for related data.
   * @returns A TaskEither with the workflow result or an error if not found.
   */
  getWorkflowByName<T extends WorkflowDecoratorSelector>(
    workflowName: string,
    includeRef?: T
  ): TaskEither<WorkflowGetError, DecoratedWorkflow<T>> {
    const identifier: Identifier = {type: "name", identifier: workflowName}
    return this.getWorkflow(identifier, includeRef)
  }

  /**
   * Lists workflows with pagination.
   * @param request The request containing pagination and include options.
   * @returns A TaskEither with the list of workflows or an error.
   */
  listWorkflows<TInclude extends WorkflowDecoratorSelector>(
    request: ListWorkflowsRequestRepo<TInclude>
  ): TaskEither<WorkflowGetError, ListWorkflowsResponse<TInclude>> {
    const prismaInclude = mapDomainSelectorToPrismaSelector(request.include)

    return pipe(
      request,
      TE.right,
      TE.chainW(this.listWorkflowsTask<TInclude, PrismaWorkflowDecoratorSelector>()),
      TE.chainEitherKW(result => {
        const workflowsEither = E.traverseArray((workflow: PrismaDecoratedWorkflow<PrismaWorkflowDecoratorSelector>) =>
          mapWorkflowToDomain(workflow, prismaInclude)
        )(result.workflows)

        if (E.isLeft(workflowsEither)) return workflowsEither

        return E.right({
          workflows: workflowsEither.right as DecoratedWorkflow<TInclude>[],
          pagination: result.pagination
        })
      })
    )
  }

  updateWorkflow<T extends WorkflowDecoratorSelector>(
    workflowId: string,
    data: ConcurrentSafeWorkflowUpdateData,
    includeRef?: T
  ): TaskEither<WorkflowUpdateError, DecoratedWorkflow<T>> {
    const prismaInclude = mapDomainSelectorToPrismaSelector(includeRef)

    return pipe(
      {workflowId, data, includeRef: prismaInclude},
      TE.right,
      TE.chainW(this.updateWorkflowTask<PrismaWorkflowDecoratorSelector>()),
      TE.chainEitherKW(result => mapWorkflowToDomain(result, prismaInclude))
    )
  }

  updateWorkflowConcurrentSafe<T extends WorkflowDecoratorSelector>(
    workflowId: string,
    occCheck: bigint,
    data: ConcurrentUnsafeWorkflowUpdateData,
    includeRef?: T
  ): TaskEither<WorkflowUpdateError, DecoratedWorkflow<T>> {
    const prismaInclude = mapDomainSelectorToPrismaSelector(includeRef)

    return pipe(
      {workflowId, data, occCheck, includeRef: prismaInclude},
      TE.right,
      TE.chainW(this.updateWorkflowTask<PrismaWorkflowDecoratorSelector>()),
      TE.chainEitherKW(result => mapWorkflowToDomain(result, prismaInclude))
    )
  }

  countActiveWorkflowsByTemplateId(templateId: string): TaskEither<UnknownError, number> {
    return TE.tryCatch(
      () =>
        this.dbClient.cx.workflow.count({
          where: {
            workflowTemplateId: templateId,
            status: {
              notIn: WORKFLOW_TERMINAL_STATUSES
            }
          }
        }),
      error => {
        Logger.error(`Error counting active workflows for template ${templateId}`, error)
        return "unknown_error"
      }
    )
  }

  countActiveWorkflows(): TaskEither<UnknownError, number> {
    return TE.tryCatch(
      () =>
        this.dbClient.cx.workflow.count({
          where: {
            status: {
              notIn: WORKFLOW_TERMINAL_STATUSES
            }
          }
        }),
      error => {
        Logger.error("Error counting all active workflows", error)
        return "unknown_error"
      }
    )
  }

  getParentWorkflowTemplate(workflowId: string): TaskEither<WorkflowGetParentTemplateError, string> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.cx.workflow.findUnique({
            where: {id: workflowId},
            select: {workflowTemplateId: true}
          }),
        error => {
          Logger.error(`Error getting parent workflow template for workflow ${workflowId}`, error)
          return "unknown_error" as const
        }
      ),
      chainNullableToLeft("workflow_not_found" as const),
      TE.map(workflow => workflow.workflowTemplateId)
    )
  }

  private updateWorkflowTask<T extends PrismaWorkflowDecoratorSelector>(): (data: {
    workflowId: string
    data: Omit<Prisma.WorkflowUpdateInput, "id" | "occ">
    occCheck?: bigint
    includeRef?: T
  }) => TaskEither<WorkflowUpdateError, PrismaDecoratedWorkflow<T>> {
    return ({workflowId, data, occCheck, includeRef}) =>
      TE.tryCatchK(
        () => this.updateWorkflowTaskNoErrorHandling({workflowId, data, occCheck, includeRef}),
        error => {
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Workflow)) return "concurrency_error" as const
          Logger.error(`Error while updating workflow ${workflowId}. Unknown error`, error)
          return "unknown_error" as const
        }
      )()
  }

  private updateWorkflowTaskNoErrorHandling<T extends PrismaWorkflowDecoratorSelector>(input: {
    workflowId: string
    data: Omit<Prisma.WorkflowUpdateInput, "id" | "occ">
    occCheck?: bigint
    includeRef?: T
  }): Promise<PrismaDecoratedWorkflow<T>> {
    const {workflowId, data, occCheck, includeRef} = input
    const where: Prisma.WorkflowWhereUniqueInput = {id: workflowId, occ: occCheck}
    const include = includeRef?.workflowTemplates ? {workflowTemplates: true} : undefined

    // TODO(long-term): try to remove the cast
    return this.dbClient.cx.workflow.update({where, data, include}) as unknown as Promise<PrismaDecoratedWorkflow<T>>
  }

  private getWorkflow<T extends WorkflowDecoratorSelector>(
    identifier: Identifier,
    include?: T
  ): TaskEither<WorkflowGetError, DecoratedWorkflow<T>> {
    const prismaInclude = mapDomainSelectorToPrismaSelector(include)

    return pipe(
      identifier,
      TE.right,
      TE.chainW(this.getObjectTask(prismaInclude)),
      chainNullableToLeft("workflow_not_found" as const),
      TE.chainEitherKW(result => mapWorkflowToDomain(result, prismaInclude))
    )
  }

  private getObjectTask<T extends PrismaWorkflowDecoratorSelector>(
    include?: T
  ): (identifier: Identifier) => TaskEither<WorkflowGetError, PrismaDecoratedWorkflow<T> | null> {
    return identifier =>
      TE.tryCatchK(
        () => this.getObjectTaskNoErrorHandling(identifier, include),
        error => {
          Logger.error(`Error while retrieving workflow by ${identifier.type}. Unknown error`, error)
          return "unknown_error" as const
        }
      )()
  }

  private async getObjectTaskNoErrorHandling<T extends PrismaWorkflowDecoratorSelector>(
    identifier: Identifier,
    include?: T
  ): Promise<PrismaDecoratedWorkflow<T> | null> {
    const where: Prisma.WorkflowWhereUniqueInput = {
      id: identifier.type === "id" ? identifier.identifier : undefined,
      name: identifier.type === "name" ? identifier.identifier : undefined
    }

    const includeOptions = include?.workflowTemplates !== undefined ? {workflowTemplates: true} : undefined

    return this.dbClient.cx.workflow.findUnique({
      where,
      include: includeOptions
    }) as Promise<PrismaDecoratedWorkflow<T> | null>
  }

  private persistWorkflow(): (data: CreateWorkflowRepo) => TaskEither<CreateWorkflowRepoError, PrismaWorkflow> {
    return data =>
      TE.tryCatchK(
        () =>
          this.dbClient.cx.workflow.create({
            data: {
              id: data.workflow.id,
              name: data.workflow.name,
              description: data.workflow.description,
              status: data.workflow.status,
              createdAt: data.workflow.createdAt,
              updatedAt: data.workflow.updatedAt,
              occ: POSTGRES_BIGINT_LOWER_BOUND,
              recalculationRequired: data.workflow.recalculationRequired,
              workflowTemplateId: data.workflow.workflowTemplateId,
              expiresAt: data.workflow.expiresAt
            }
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["name"])) return "workflow_already_exists"
          Logger.error(`Error creating workflow: ${error}`, error)
          return "unknown_error" as const
        }
      )()
  }

  private listWorkflowsTask<
    DomainSelectors extends WorkflowDecoratorSelector,
    PrismaSelectors extends PrismaWorkflowDecoratorSelector
  >(): (
    request: ListWorkflowsRequestRepo<DomainSelectors>
  ) => TaskEither<
    WorkflowGetError,
    {workflows: PrismaDecoratedWorkflow<PrismaSelectors>[]; pagination: {total: number; page: number; limit: number}}
  > {
    return request =>
      TE.tryCatchK(
        () => this.listWorkflowsTaskNoErrorHandling<DomainSelectors, PrismaSelectors>()(request),
        error => {
          Logger.error("Error while listing workflows. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  private listWorkflowsTaskNoErrorHandling<
    DomainSelectors extends WorkflowDecoratorSelector,
    PrismaSelectors extends PrismaWorkflowDecoratorSelector = object
  >(): (request: ListWorkflowsRequestRepo<DomainSelectors>) => Promise<{
    workflows: PrismaDecoratedWorkflow<PrismaSelectors>[]
    pagination: {total: number; page: number; limit: number}
  }> {
    return async request => {
      const {pagination, include, filters} = request

      const prismaInclude: Prisma.WorkflowInclude = include?.workflowTemplate ? {workflowTemplates: true} : {}

      // Build the where clause based on the selected filters
      const where: Prisma.WorkflowWhereInput = {}

      if (filters?.includeOnlyNonTerminalState)
        where.status = {
          notIn: WORKFLOW_TERMINAL_STATUSES
        }

      if (filters?.workflowTemplateId) where.workflowTemplateId = filters.workflowTemplateId
      else if (filters?.workflowTemplateName) where.workflowTemplates = {name: filters.workflowTemplateName}

      if (filters?.includeGroups && filters.includeGroups.length > 0) {
        where.workflowTemplates = {
          ...(where.workflowTemplates as Prisma.WorkflowTemplateWhereInput),
          OR: filters.includeGroups.map(groupId => ({
            approvalRule: {
              string_contains: groupId
            }
          }))
        }
      }

      const orderBy: Prisma.WorkflowOrderByWithRelationInput[] = []
      const sortItems = request.sort ?? []

      if (sortItems.length > 0) {
        for (const sortItem of sortItems) {
          orderBy.push({[sortItem.param]: sortItem.order})
        }
      }

      if (orderBy.length === 0) orderBy.push({updatedAt: "desc"})

      const [rawWorkflows, total] = await Promise.all([
        this.dbClient.cx.workflow.findMany({
          skip: pagination ? (pagination.page - 1) * pagination.limit : undefined,
          take: pagination ? pagination.limit : undefined,
          include: prismaInclude,
          where,
          orderBy
        }),
        this.dbClient.cx.workflow.count({where})
      ])

      const workflows = rawWorkflows.map(w => ({...w, occ: BigInt(w.occ)}))
      return {
        workflows: workflows as PrismaDecoratedWorkflow<PrismaSelectors>[],
        pagination: {total, page: pagination ? pagination.page : 1, limit: pagination ? pagination.limit : total}
      }
    }
  }
}

export interface PrismaWorkflowDecorators {
  workflowTemplates: PrismaWorkflowTemplate
}

export type PrismaWorkflowDecoratorSelector = Partial<Record<keyof PrismaWorkflowDecorators, boolean>>

export type PrismaDecoratedWorkflow<T extends PrismaWorkflowDecoratorSelector> = DecorableEntity<
  PrismaWorkflow,
  PrismaWorkflowDecorators,
  T
>

export function iPrismaDecoratedWorkflow<K extends keyof PrismaWorkflowDecorators>(
  workflow: PrismaDecoratedWorkflow<PrismaWorkflowDecoratorSelector>,
  key: K,
  options?: PrismaWorkflowDecoratorSelector
): workflow is PrismaDecoratedWorkflow<PrismaWorkflowDecoratorSelector & Record<K, true>> {
  return isDecoratedWith<
    PrismaDecoratedWorkflow<PrismaWorkflowDecoratorSelector>,
    PrismaWorkflowDecorators,
    PrismaWorkflowDecoratorSelector,
    keyof PrismaWorkflowDecorators
  >(workflow, key, options)
}

export function mapDomainSelectorToPrismaSelector<T extends WorkflowDecoratorSelector>(
  domainSelector?: T
): PrismaWorkflowDecoratorSelector | undefined {
  if (!domainSelector) return undefined

  return {
    workflowTemplates: domainSelector.workflowTemplate
  }
}
