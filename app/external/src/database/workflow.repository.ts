import {fromPromise, fromEitherPromise, fromPromiseK} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {
  DecoratedWorkflow,
  TenantContext,
  Versioned,
  Workflow,
  WorkflowDecoratorSelector,
  WorkflowFactory,
  WorkflowTemplateFactory,
  WorkflowTemplateValidationError,
  WorkflowValidationError,
  WORKFLOW_TERMINAL_STATUSES,
  WorkflowExpirationSchedule,
  WorkflowExpirationScheduleFactory,
  WorkflowExpirationScheduleValidationError
} from "@domain"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {
  ConcurrentSafeWorkflowUpdateData,
  ConcurrentUnsafeWorkflowUpdateData,
  CreateWorkflowRepo,
  CreateWorkflowRepoError,
  ListWorkflowsRequestRepo,
  ListWorkflowsResponseRepo,
  WorkflowGetError,
  WorkflowGetParentTemplateError,
  WorkflowRepository,
  WorkflowUpdateError
} from "@services"
import {WorkflowExpirationScheduleRepository} from "@services/workflow/interfaces"
import {UnknownError} from "@services/error"
import {CryptoError} from "@services/encryption/interfaces"
import {Prisma, Workflow as PrismaWorkflow, WorkflowTemplate as PrismaWorkflowTemplate} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WorkflowTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {chainNullableToLeft} from "./utils"
import {ConflictingIsolationLevelError} from "./database-client"

import {TaskEither} from "fp-ts/TaskEither"
import {DecorableEntity, isDecoratedWith} from "@utils"

interface Identifier {
  type: "id" | "name"
  identifier: string
}

@Injectable()
export class WorkflowDbRepository implements WorkflowRepository, WorkflowExpirationScheduleRepository {
  constructor(
    private readonly dbClient: WorkflowTenantClient,
    private readonly encryptionService: TenantEncryptionService
  ) {}

  private decryptWorkflow<T extends PrismaWorkflowDecoratorSelector>(
    context: TenantContext,
    workflow: PrismaDecoratedWorkflow<T>
  ): TE.TaskEither<CryptoError, PrismaDecoratedWorkflow<T>> {
    if (iPrismaDecoratedWorkflow(workflow, "workflowTemplates", {workflowTemplates: true})) {
      const template = workflow.workflowTemplates
      if (template.encActions === null) return TE.left("unsupported_format")
      return pipe(
        this.encryptionService.decrypt(encryptionContext(context, template.id), template.encActions),
        TE.chainEitherKW(plaintext =>
          E.tryCatch(
            () => JSON.parse(plaintext) as unknown,
            error => {
              Logger.error(`Failed to parse decrypted actions JSON: ${String(error)}`, error)
              return "decryption_failed" as const
            }
          )
        ),
        TE.map(decryptedActions => {
          const updatedTemplate = {...template, actions: decryptedActions}
          return {...workflow, workflowTemplates: updatedTemplate}
        })
      )
    }
    return TE.right(workflow)
  }

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

  getDueExpirationSchedule(
    context: TenantContext,
    dueBefore: Date,
    scheduledBefore: Date
  ): TE.TaskEither<UnknownError | WorkflowExpirationScheduleValidationError, WorkflowExpirationSchedule | undefined> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.workflowExpirationSchedule.findFirst({
            where: {
              organizationId: context.organizationId,
              nextSweepAt: {lte: dueBefore},
              OR: [{lastScheduledAt: null}, {lastScheduledAt: {lte: scheduledBefore}}]
            },
            select: {lastSweptAt: true}
          }),
        error => this.mapUnknownError(error, "get due expiration schedule")
      ),
      TE.chainEitherKW(schedule =>
        schedule
          ? WorkflowExpirationScheduleFactory.validate({
              organizationId: context.organizationId,
              lastSweptAt: schedule.lastSweptAt ?? undefined
            })
          : E.right(undefined)
      )
    )
  }

  // TODO: Is this name appropriate ? What are the claiming ?
  claimExpirationSchedule(
    context: TenantContext,
    scheduledAt: Date,
    scheduledBefore: Date
  ): TE.TaskEither<UnknownError, boolean> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.workflowExpirationSchedule.updateMany({
            where: {
              organizationId: context.organizationId,
              nextSweepAt: {lte: scheduledAt},
              OR: [{lastScheduledAt: null}, {lastScheduledAt: {lte: scheduledBefore}}]
            },
            data: {lastScheduledAt: scheduledAt}
          }),
        error => this.mapUnknownError(error, "claim expiration schedule")
      ),
      TE.map(claimed => claimed.count > 0)
    )
  }

  // TODO: Can this method be split and orchestrate in teh service instead ?
  completeExpirationSchedule(
    context: TenantContext,
    sweptAt: Date
  ): TE.TaskEither<UnknownError | "concurrency_error", void> {
    return fromEitherPromise(
      async () => {
        const schedule = await this.dbClient.cx.workflowExpirationSchedule.findUniqueOrThrow({
          where: {organizationId: context.organizationId},
          select: {occ: true}
        })
        const next = await this.dbClient.cx.workflow.aggregate({
          where: {
            organizationId: context.organizationId,
            status: {notIn: WORKFLOW_TERMINAL_STATUSES},
            recalculationRequired: false
          },
          _min: {expiresAt: true}
        })
        // Every registration increments OCC, including registrations that keep the deadline.
        // A conflict rolls back the batch so the service can retry the whole transaction.
        const updated = await this.dbClient.cx.workflowExpirationSchedule.updateMany({
          where: {organizationId: context.organizationId, occ: schedule.occ},
          data: {nextSweepAt: next._min.expiresAt, lastSweptAt: sweptAt, occ: {increment: 1}}
        })
        return updated.count === 1 ? E.right(undefined) : E.left("concurrency_error" as const)
      },
      error => this.mapUnknownError(error, "complete expiration schedule")
    )
  }

  registerWorkflowExpiration(context: TenantContext, expiresAt: Date): TE.TaskEither<UnknownError, void> {
    return fromPromise(
      async () => {
        // TODO: Why are we doing two updates on the same object ? I am very confused
        await this.dbClient.cx.workflowExpirationSchedule.update({
          where: {organizationId: context.organizationId},
          data: {occ: {increment: 1}},
          select: {organizationId: true}
        })
        await this.dbClient.cx.workflowExpirationSchedule.updateMany({
          where: {
            organizationId: context.organizationId,
            OR: [{nextSweepAt: null}, {nextSweepAt: {gt: expiresAt}}]
          },
          data: {nextSweepAt: expiresAt}
        })
      },
      error => this.mapUnknownError(error, "register workflow expiration")
    )
  }

  /**
   * Gets a workflow by its UUID.
   * @param workflowId The ID of the workflow.
   * @param includeRef Include options for related data.
   * @returns A TaskEither with the workflow result or an error if not found.
   */
  getWorkflowById<T extends WorkflowDecoratorSelector>(
    context: TenantContext,
    workflowId: string,
    includeRef?: T
  ): TaskEither<WorkflowGetError, DecoratedWorkflow<T>> {
    const identifier: Identifier = {type: "id", identifier: workflowId}
    return this.getWorkflow(context, identifier, includeRef)
  }

  /**
   * Gets a workflow by its unique name.
   * @param name The name of the workflow.
   * @param includeRef Include options for related data.
   * @returns A TaskEither with the workflow result or an error if not found.
   */
  getWorkflowByName<T extends WorkflowDecoratorSelector>(
    context: TenantContext,
    workflowName: string,
    includeRef?: T
  ): TaskEither<WorkflowGetError, DecoratedWorkflow<T>> {
    const identifier: Identifier = {type: "name", identifier: workflowName}
    return this.getWorkflow(context, identifier, includeRef)
  }

  /**
   * Lists workflows with pagination.
   * @param request The request containing pagination and include options.
   * @returns A TaskEither with the list of workflows or an error.
   */
  listWorkflows<TInclude extends WorkflowDecoratorSelector>(
    context: TenantContext,
    request: ListWorkflowsRequestRepo<TInclude>
  ): TaskEither<WorkflowGetError, ListWorkflowsResponseRepo<TInclude>> {
    const prismaInclude = mapDomainSelectorToPrismaSelector(request.include)

    return pipe(
      request,
      TE.right,
      TE.chainW(this.listWorkflowsTask<TInclude, PrismaWorkflowDecoratorSelector>(context)),
      TE.chainEitherKW(result => {
        const workflowsEither = E.traverseArray((workflow: PrismaDecoratedWorkflow<PrismaWorkflowDecoratorSelector>) =>
          mapWorkflowToDomain(workflow, prismaInclude)
        )(result.workflows)

        if (E.isLeft(workflowsEither)) return workflowsEither

        return E.right({
          workflows: workflowsEither.right as DecoratedWorkflow<TInclude>[],
          total: result.total
        })
      })
    )
  }

  updateWorkflow<T extends WorkflowDecoratorSelector>(
    context: TenantContext,
    workflowId: string,
    data: ConcurrentSafeWorkflowUpdateData,
    includeRef?: T
  ): TaskEither<WorkflowUpdateError, DecoratedWorkflow<T>> {
    const prismaInclude = mapDomainSelectorToPrismaSelector(includeRef)

    return pipe(
      {context, workflowId, data, includeRef: prismaInclude},
      TE.right,
      TE.chainW(this.updateWorkflowTask<PrismaWorkflowDecoratorSelector>()),
      TE.chainEitherKW(result => mapWorkflowToDomain(result, prismaInclude))
    )
  }

  updateWorkflowConcurrentSafe<T extends WorkflowDecoratorSelector>(
    context: TenantContext,
    workflowId: string,
    occCheck: bigint,
    data: ConcurrentUnsafeWorkflowUpdateData,
    includeRef?: T
  ): TaskEither<WorkflowUpdateError, DecoratedWorkflow<T>> {
    const prismaInclude = mapDomainSelectorToPrismaSelector(includeRef)

    return pipe(
      {context, workflowId, data, occCheck, includeRef: prismaInclude},
      TE.right,
      TE.chainW(this.updateWorkflowTask<PrismaWorkflowDecoratorSelector>()),
      TE.chainEitherKW(result => mapWorkflowToDomain(result, prismaInclude))
    )
  }

  countActiveWorkflowsByTemplateId(context: TenantContext, templateId: string): TaskEither<UnknownError, number> {
    return fromPromise(
      () =>
        this.dbClient.cx.workflow.count({
          where: {
            organizationId: context.organizationId,
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

  countActiveWorkflows(context: TenantContext): TaskEither<UnknownError, number> {
    return fromPromise(
      () =>
        this.dbClient.cx.workflow.count({
          where: {
            organizationId: context.organizationId,
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

  getParentWorkflowTemplate(
    context: TenantContext,
    workflowId: string
  ): TaskEither<WorkflowGetParentTemplateError, string> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.workflow.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: workflowId}},
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

  findExpiredWorkflows(context: TenantContext, now: Date, limit = 1000): TaskEither<UnknownError, string[]> {
    return fromPromise(
      async () => {
        // RISK ACCEPTANCE COMMENT:
        // If any database validation/parsing failure occurs for this batch, the entire execution halts.
        // Since we only select the basic string UUID 'id', the risk is minimal for this iteration.
        // TODO (long-term): Implement a row-by-row parsing/validation wrapper to handle corrupt records gracefully.
        const workflows = await this.dbClient.cx.workflow.findMany({
          where: {
            organizationId: context.organizationId,
            status: {
              notIn: WORKFLOW_TERMINAL_STATUSES
            },
            expiresAt: {
              lt: now
            },
            recalculationRequired: false
          },
          select: {
            id: true
          },
          orderBy: [{expiresAt: "asc"}, {id: "asc"}],
          take: limit
        })
        return workflows.map(w => w.id)
      },
      error => {
        Logger.error("Error finding expired workflows", error)
        return "unknown_error" as const
      }
    )
  }

  markWorkflowsAsRecalculationRequired(context: TenantContext, workflowIds: string[]): TaskEither<UnknownError, void> {
    return fromPromise(
      async () => {
        if (workflowIds.length === 0) return
        await this.dbClient.cx.workflow.updateMany({
          where: {
            organizationId: context.organizationId,
            id: {
              in: workflowIds
            }
          },
          data: {
            recalculationRequired: true
          }
        })
      },
      error => {
        Logger.error(`Error marking workflows as recalculation required: ${workflowIds.join(", ")}`, error)
        return "unknown_error" as const
      }
    )
  }

  private updateWorkflowTask<T extends PrismaWorkflowDecoratorSelector>(): (data: {
    context: TenantContext
    workflowId: string
    data: Omit<Prisma.WorkflowUpdateInput, "id" | "occ">
    occCheck?: bigint
    includeRef?: T
  }) => TaskEither<WorkflowUpdateError, PrismaDecoratedWorkflow<T>> {
    return ({context, workflowId, data, occCheck, includeRef}) =>
      pipe(
        fromPromise(
          () => this.updateWorkflowTaskNoErrorHandling({context, workflowId, data, occCheck, includeRef}),
          error => {
            if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Workflow)) return "concurrency_error" as const
            Logger.error(`Error while updating workflow ${workflowId}. Unknown error`, error)
            return "unknown_error" as const
          }
        ),
        TE.chainW(result => this.decryptWorkflow(context, result))
      )
  }

  private updateWorkflowTaskNoErrorHandling<T extends PrismaWorkflowDecoratorSelector>(input: {
    context: TenantContext
    workflowId: string
    data: Omit<Prisma.WorkflowUpdateInput, "id" | "occ">
    occCheck?: bigint
    includeRef?: T
  }): Promise<PrismaDecoratedWorkflow<T>> {
    const {context, workflowId, data, occCheck, includeRef} = input
    const where: Prisma.WorkflowWhereUniqueInput = {
      organizationId_id: {organizationId: context.organizationId, id: workflowId},
      occ: occCheck
    }
    const include = includeRef?.workflowTemplates ? {workflowTemplates: true} : undefined

    // TODO(long-term): try to remove the cast
    return this.dbClient.cx.workflow.update({
      where,
      data: {...data, ...(occCheck === undefined ? {} : {occ: {increment: 1}})},
      include
    }) as unknown as Promise<PrismaDecoratedWorkflow<T>>
  }

  private getWorkflow<T extends WorkflowDecoratorSelector>(
    context: TenantContext,
    identifier: Identifier,
    include?: T
  ): TaskEither<WorkflowGetError, DecoratedWorkflow<T>> {
    const prismaInclude = mapDomainSelectorToPrismaSelector(include)

    return pipe(
      identifier,
      TE.right,
      TE.chainW(this.getObjectTask(context, prismaInclude)),
      chainNullableToLeft("workflow_not_found" as const),
      TE.chainEitherKW(result => mapWorkflowToDomain(result, prismaInclude))
    )
  }

  private getObjectTask<T extends PrismaWorkflowDecoratorSelector>(
    context: TenantContext,
    include?: T
  ): (identifier: Identifier) => TaskEither<WorkflowGetError, PrismaDecoratedWorkflow<T> | null> {
    return identifier =>
      pipe(
        fromPromise(
          () => this.getObjectTaskNoErrorHandling(context, identifier, include),
          error => {
            Logger.error(`Error while retrieving workflow by ${identifier.type}. Unknown error`, error)
            return "unknown_error" as const
          }
        ),
        TE.chainW(result => {
          if (!result) return TE.right(null)
          return this.decryptWorkflow(context, result)
        })
      )
  }

  private async getObjectTaskNoErrorHandling<T extends PrismaWorkflowDecoratorSelector>(
    context: TenantContext,
    identifier: Identifier,
    include?: T
  ): Promise<PrismaDecoratedWorkflow<T> | null> {
    const where: Prisma.WorkflowWhereUniqueInput = {
      organizationId_id:
        identifier.type === "id" ? {organizationId: context.organizationId, id: identifier.identifier} : undefined,
      organizationId_name:
        identifier.type === "name" ? {organizationId: context.organizationId, name: identifier.identifier} : undefined
    }

    const includeOptions = include?.workflowTemplates !== undefined ? {workflowTemplates: true} : undefined

    return this.dbClient.cx.workflow.findUnique({
      where,
      include: includeOptions
    }) as Promise<PrismaDecoratedWorkflow<T> | null>
  }

  private persistWorkflow(): (data: CreateWorkflowRepo) => TaskEither<CreateWorkflowRepoError, PrismaWorkflow> {
    return data =>
      fromPromiseK(
        () =>
          this.dbClient.cx.workflow.create({
            data: {
              id: data.workflow.id,
              organizationId: data.workflow.organizationId,
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
          if (isPrismaUniqueConstraintError(error, ["organization_id", "name"], "workflows_organization_name_unique"))
            return "workflow_already_exists"
          Logger.error(`Error creating workflow: ${String(error)}`, error)
          return "unknown_error" as const
        }
      )()
  }

  private listWorkflowsTask<
    DomainSelectors extends WorkflowDecoratorSelector,
    PrismaSelectors extends PrismaWorkflowDecoratorSelector
  >(
    context: TenantContext
  ): (
    request: ListWorkflowsRequestRepo<DomainSelectors>
  ) => TaskEither<WorkflowGetError, {workflows: PrismaDecoratedWorkflow<PrismaSelectors>[]; total: number}> {
    return request =>
      pipe(
        fromPromise(
          () => this.listWorkflowsTaskNoErrorHandling<DomainSelectors, PrismaSelectors>(context)(request),
          error => {
            if (error instanceof ConflictingIsolationLevelError) return "conflicting_isolation_level" as const
            Logger.error("Error while listing workflows. Unknown error", error)
            return "unknown_error" as const
          }
        ),
        TE.chainW(result =>
          pipe(
            result.workflows,
            TE.traverseArray(w => this.decryptWorkflow(context, w)),
            TE.map(decryptedWorkflows => ({
              workflows: decryptedWorkflows as PrismaDecoratedWorkflow<PrismaSelectors>[],
              total: result.total
            }))
          )
        )
      )
  }

  private listWorkflowsTaskNoErrorHandling<
    DomainSelectors extends WorkflowDecoratorSelector,
    PrismaSelectors extends PrismaWorkflowDecoratorSelector = object
  >(
    context: TenantContext
  ): (request: ListWorkflowsRequestRepo<DomainSelectors>) => Promise<{
    workflows: PrismaDecoratedWorkflow<PrismaSelectors>[]
    total: number
  }> {
    return async request => {
      this.dbClient.assertIsolationLevel(Prisma.TransactionIsolationLevel.RepeatableRead)
      const {pagination, include, filters} = request

      const prismaInclude: Prisma.WorkflowInclude = include?.workflowTemplate ? {workflowTemplates: true} : {}

      // Build the where clause based on the selected filters
      const where: Prisma.WorkflowWhereInput = {organizationId: context.organizationId}

      if (filters?.includeOnlyNonTerminalState)
        where.status = {
          notIn: WORKFLOW_TERMINAL_STATUSES
        }

      if (filters?.workflowTemplateId) where.workflowTemplateId = filters.workflowTemplateId
      else if (filters?.workflowTemplateName) where.workflowTemplates = {name: filters.workflowTemplateName}

      if (filters?.includeGroups && filters.includeGroups.length > 0)
        where.workflowTemplates = {
          ...(where.workflowTemplates as Prisma.WorkflowTemplateWhereInput),
          OR: filters.includeGroups.map(groupId => ({
            approvalRule: {
              string_contains: groupId
            }
          }))
        }

      const orderBy: Prisma.WorkflowOrderByWithRelationInput[] = []
      const sortItems = request.sort ?? []

      if (sortItems.length > 0) for (const sortItem of sortItems) orderBy.push({[sortItem.param]: sortItem.order})

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

      const workflows = rawWorkflows.map(w => ({
        ...w,
        occ: BigInt(w.occ)
      })) as PrismaDecoratedWorkflow<PrismaSelectors>[]
      return {
        workflows: workflows,
        total
      }
    }
  }
  private mapUnknownError(error: unknown, operation: string): UnknownError {
    Logger.error(`Workflow repository ${operation} failed`, error)
    return "unknown_error"
  }
}

export interface PrismaWorkflowDecorators {
  workflowTemplates: PrismaWorkflowTemplate & {readonly actions?: unknown}
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

function mapToDomainVersionedWorkflow(row: PrismaWorkflow): E.Either<WorkflowValidationError, Versioned<Workflow>> {
  return pipe(
    WorkflowFactory.validate({
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      description: row.description ?? undefined,
      status: row.status,
      recalculationRequired: row.recalculationRequired,
      workflowTemplateId: row.workflowTemplateId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }),
    E.map(workflow => ({...workflow, occ: row.occ}))
  )
}

function encryptionContext(context: TenantContext, templateId: string) {
  return {
    organizationId: context.organizationId,
    resourceType: "workflow_template" as const,
    resourceId: templateId,
    field: "actions" as const,
    formatVersion: 1 as const
  }
}

function mapWorkflowToDomain<
  DomainSelectors extends WorkflowDecoratorSelector,
  PrismaSelectors extends PrismaWorkflowDecoratorSelector
>(
  dbObject: PrismaDecoratedWorkflow<PrismaSelectors>,
  include?: PrismaSelectors
): E.Either<
  WorkflowValidationError | WorkflowTemplateValidationError | "unknown_error",
  DecoratedWorkflow<DomainSelectors>
> {
  if (include?.workflowTemplates === true) {
    if (iPrismaDecoratedWorkflow(dbObject, "workflowTemplates", include)) {
      const row = dbObject.workflowTemplates
      return pipe(
        mapToDomainVersionedWorkflow(dbObject),
        E.bindTo("workflow"),
        E.bindW("workflowTemplate", () =>
          pipe(
            WorkflowTemplateFactory.validate({
              id: row.id,
              organizationId: row.organizationId,
              name: row.name,
              version: row.version,
              description: row.description ?? undefined,
              approvalRule: row.approvalRule,
              actions: row.actions,
              defaultExpiresInHours: row.defaultExpiresInHours ?? undefined,
              status: row.status,
              allowVotingOnDeprecatedTemplate: row.allowVotingOnDeprecatedTemplate,
              spaceId: row.spaceId,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt
            }),
            E.map(template => ({...template, occ: row.occ}))
          )
        ),
        E.map(({workflow, workflowTemplate}) => ({...workflow, workflowTemplate}))
      )
    }
    return E.left("unknown_error")
  }
  return mapToDomainVersionedWorkflow(dbObject) as E.Either<WorkflowValidationError, DecoratedWorkflow<DomainSelectors>>
}
