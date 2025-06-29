import {
  DecoratedWorkflow,
  Workflow,
  WorkflowDecoratorSelector,
  WorkflowTemplateValidationError,
  WorkflowValidationError
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
  ListWorkflowsRequest,
  ListWorkflowsResponse
} from "@services"
import {TaskEither} from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {isPrismaUniqueConstraintError} from "./errors"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/lib/function"
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
    request: ListWorkflowsRequest<TInclude>
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
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
            return "concurrency_error" as const
          }
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

    // TODO: try to remove the cast
    return this.dbClient.workflow.update({where, data, include}) as unknown as Promise<PrismaDecoratedWorkflow<T>>
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

    return this.dbClient.workflow.findUnique({
      where,
      include: includeOptions
    }) as Promise<PrismaDecoratedWorkflow<T> | null>
  }

  private persistWorkflow(): (data: CreateWorkflowRepo) => TaskEither<CreateWorkflowRepoError, PrismaWorkflow> {
    return data =>
      TE.tryCatchK(
        () =>
          this.dbClient.workflow.create({
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
    request: ListWorkflowsRequest<DomainSelectors>
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
  >(): (request: ListWorkflowsRequest<DomainSelectors>) => Promise<{
    workflows: PrismaDecoratedWorkflow<PrismaSelectors>[]
    pagination: {total: number; page: number; limit: number}
  }> {
    return async request => {
      const {
        pagination: {page, limit},
        include
      } = request

      const prismaInclude: Prisma.WorkflowInclude = include?.workflowTemplate ? {workflowTemplates: true} : {}

      const [workflows, total] = await this.dbClient.$transaction([
        this.dbClient.workflow.findMany({
          skip: (page - 1) * limit,
          take: limit,
          include: prismaInclude
        }),
        this.dbClient.workflow.count()
      ])

      return {
        workflows: workflows as PrismaDecoratedWorkflow<PrismaSelectors>[],
        pagination: {total, page, limit}
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
