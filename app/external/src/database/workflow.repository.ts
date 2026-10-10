import {Injectable, Logger} from "@nestjs/common"
import {
  DecoratedWorkflow,
  TenantContext,
  Versioned,
  Workflow,
  WorkflowDecoratorSelector,
  WorkflowFactory,
  WorkflowTemplate,
  WorkflowTemplateFactory,
  WorkflowTemplateValidationError,
  WorkflowValidationError,
  WORKFLOW_TERMINAL_STATUSES
} from "@domain"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {
  ConcurrentSafeWorkflowUpdateData,
  ConcurrentUnsafeWorkflowUpdateData,
  CreateWorkflowRepo,
  CreateWorkflowRepoError,
  ListWorkflowsRequestRepo,
  ListWorkflowsResponse,
  WorkflowGetError,
  WorkflowGetParentTemplateError,
  WorkflowRepository,
  WorkflowUpdateError
} from "@services"
import {WorkflowExpirationSchedule, WorkflowExpirationScheduleRepository} from "@services/workflow/interfaces"
import {EncryptionError, UnknownError} from "@services/error"
import {Prisma, Workflow as PrismaWorkflow, WorkflowTemplate as PrismaWorkflowTemplate} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WorkflowTenantClient} from "./tenant-database-clients"
import {isPrismaUniqueConstraintError} from "./errors"

type WorkflowWithTemplate = PrismaWorkflow & {readonly workflowTemplates: PrismaWorkflowTemplate}
type WorkflowResult =
  Versioned<Workflow> | (Versioned<Workflow> & {readonly workflowTemplate: Versioned<WorkflowTemplate>})

@Injectable()
export class WorkflowDbRepository implements WorkflowRepository, WorkflowExpirationScheduleRepository {
  constructor(
    private readonly dbClient: WorkflowTenantClient,
    private readonly tenantEncryption: TenantEncryptionService
  ) {}

  createWorkflow(
    context: TenantContext,
    data: CreateWorkflowRepo
  ): TE.TaskEither<CreateWorkflowRepoError | WorkflowValidationError | WorkflowTemplateValidationError, Workflow> {
    if (data.workflow.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    return pipe(
      TE.tryCatch<"workflow_already_exists" | UnknownError, PrismaWorkflow>(
        () =>
          this.dbClient.cx.workflow.create({
            data: {
              id: data.workflow.id,
              organizationId: context.organizationId,
              name: data.workflow.name,
              description: data.workflow.description ?? null,
              status: data.workflow.status,
              recalculationRequired: data.workflow.recalculationRequired,
              workflowTemplateId: data.workflow.workflowTemplateId,
              expiresAt: data.workflow.expiresAt,
              createdAt: data.workflow.createdAt,
              updatedAt: data.workflow.updatedAt,
              occ: 0n
            }
          }),
        error => this.mapCreateError(error)
      ),
      TE.chainEitherKW(mapWorkflow),
      TE.chainFirstW(() => this.registerWorkflowExpiration(context, data.workflow.expiresAt))
    )
  }

  getDueExpirationSchedule(
    context: TenantContext,
    dueBefore: Date,
    scheduledBefore: Date
  ): TE.TaskEither<UnknownError, WorkflowExpirationSchedule | null> {
    return TE.tryCatch(
      async () => {
        const schedule = await this.dbClient.cx.getDueExpirationSchedule(
          context.organizationId,
          dueBefore,
          scheduledBefore
        )
        return schedule
          ? {
              organizationId: context.organizationId,
              ...(schedule.lastSweptAt === null ? {} : {lastSweptAt: schedule.lastSweptAt})
            }
          : null
      },
      error => this.mapUnknownError(error, "get due expiration schedule")
    )
  }

  claimExpirationSchedule(
    context: TenantContext,
    scheduledAt: Date,
    scheduledBefore: Date
  ): TE.TaskEither<UnknownError, boolean> {
    return TE.tryCatch(
      () => this.dbClient.cx.claimExpirationSchedule(context.organizationId, scheduledAt, scheduledBefore),
      error => this.mapUnknownError(error, "claim expiration schedule")
    )
  }

  completeExpirationSchedule(context: TenantContext, sweptAt: Date): TE.TaskEither<UnknownError, void> {
    return TE.tryCatch(
      () => this.dbClient.cx.completeExpirationSchedule(context.organizationId, sweptAt),
      error => this.mapUnknownError(error, "complete expiration schedule")
    )
  }

  private registerWorkflowExpiration(context: TenantContext, expiresAt: Date): TE.TaskEither<UnknownError, void> {
    return TE.tryCatch(
      () => this.dbClient.cx.registerWorkflowExpiration(context.organizationId, expiresAt),
      error => this.mapUnknownError(error, "register workflow expiration")
    )
  }

  getWorkflowById<T extends WorkflowDecoratorSelector>(
    context: TenantContext,
    workflowId: string,
    includeRef?: T
  ): TE.TaskEither<WorkflowGetError, DecoratedWorkflow<T>>
  getWorkflowById(
    context: TenantContext,
    workflowId: string,
    includeRef?: WorkflowDecoratorSelector
  ): TE.TaskEither<WorkflowGetError, DecoratedWorkflow<WorkflowDecoratorSelector>> {
    return this.get(context, {organizationId_id: {organizationId: context.organizationId, id: workflowId}}, includeRef)
  }

  getWorkflowByName<T extends WorkflowDecoratorSelector>(
    context: TenantContext,
    workflowName: string,
    includeRef?: T
  ): TE.TaskEither<WorkflowGetError, DecoratedWorkflow<T>>
  getWorkflowByName(
    context: TenantContext,
    workflowName: string,
    includeRef?: WorkflowDecoratorSelector
  ): TE.TaskEither<WorkflowGetError, DecoratedWorkflow<WorkflowDecoratorSelector>> {
    return this.get(
      context,
      {organizationId_name: {organizationId: context.organizationId, name: workflowName}},
      includeRef
    )
  }

  listWorkflows<T extends WorkflowDecoratorSelector>(
    context: TenantContext,
    request: ListWorkflowsRequestRepo<T>
  ): TE.TaskEither<WorkflowGetError, ListWorkflowsResponse<T>>
  listWorkflows(
    context: TenantContext,
    request: ListWorkflowsRequestRepo<WorkflowDecoratorSelector>
  ): TE.TaskEither<WorkflowGetError, ListWorkflowsResponse<WorkflowDecoratorSelector>> {
    const where = this.listWhere(context, request)
    const pagination = request.pagination
    const orderBy = toOrderBy(request.sort)
    if (request.include?.workflowTemplate === true)
      return pipe(
        TE.tryCatch<UnknownError, {readonly rows: WorkflowWithTemplate[]; readonly total: number}>(
          async () => ({
            rows: await this.dbClient.cx.workflow.findMany({
              where,
              orderBy,
              skip: pagination ? (pagination.page - 1) * pagination.limit : undefined,
              take: pagination?.limit,
              include: {workflowTemplates: true}
            }),
            total: await this.dbClient.cx.workflow.count({where})
          }),
          error => this.mapUnknownError(error, "list with template")
        ),
        TE.chainW(({rows, total}) =>
          pipe(
            rows,
            TE.traverseArray(row => this.mapWorkflowWithTemplate(context, row)),
            TE.map(workflows => ({
              workflows,
              pagination: {total, page: pagination?.page ?? 1, limit: pagination?.limit ?? total}
            }))
          )
        )
      )
    return pipe(
      TE.tryCatch<UnknownError, {readonly rows: PrismaWorkflow[]; readonly total: number}>(
        async () => {
          const total = await this.dbClient.cx.workflow.count({where})
          const rows = await this.dbClient.cx.workflow.findMany({
            where,
            orderBy,
            skip: pagination ? (pagination.page - 1) * pagination.limit : undefined,
            take: pagination?.limit
          })
          return {rows, total}
        },
        error => this.mapUnknownError(error, "list")
      ),
      TE.chainW(({rows, total}) =>
        pipe(
          rows,
          TE.traverseArray(row => TE.fromEither(mapWorkflow(row))),
          TE.map(workflows => ({
            workflows,
            pagination: {total, page: pagination?.page ?? 1, limit: pagination?.limit ?? total}
          }))
        )
      )
    )
  }

  updateWorkflow<T extends WorkflowDecoratorSelector>(
    context: TenantContext,
    workflowId: string,
    data: ConcurrentSafeWorkflowUpdateData,
    includeRef?: T
  ): TE.TaskEither<WorkflowUpdateError, DecoratedWorkflow<T>>
  updateWorkflow(
    context: TenantContext,
    workflowId: string,
    data: ConcurrentSafeWorkflowUpdateData,
    includeRef?: WorkflowDecoratorSelector
  ): TE.TaskEither<WorkflowUpdateError, DecoratedWorkflow<WorkflowDecoratorSelector>> {
    return this.update(context, workflowId, undefined, data, includeRef)
  }

  updateWorkflowConcurrentSafe<T extends WorkflowDecoratorSelector>(
    context: TenantContext,
    workflowId: string,
    occCheck: bigint,
    data: ConcurrentUnsafeWorkflowUpdateData,
    includeRef?: T
  ): TE.TaskEither<WorkflowUpdateError, DecoratedWorkflow<T>>
  updateWorkflowConcurrentSafe(
    context: TenantContext,
    workflowId: string,
    occCheck: bigint,
    data: ConcurrentUnsafeWorkflowUpdateData,
    includeRef?: WorkflowDecoratorSelector
  ): TE.TaskEither<WorkflowUpdateError, DecoratedWorkflow<WorkflowDecoratorSelector>> {
    return this.update(context, workflowId, occCheck, data, includeRef)
  }

  countActiveWorkflowsByTemplateId(context: TenantContext, templateId: string): TE.TaskEither<UnknownError, number> {
    return TE.tryCatch(
      () =>
        this.dbClient.cx.workflow.count({
          where: {
            organizationId: context.organizationId,
            workflowTemplateId: templateId,
            status: {notIn: WORKFLOW_TERMINAL_STATUSES}
          }
        }),
      error => this.mapUnknownError(error, "count by template")
    )
  }

  countActiveWorkflows(context: TenantContext): TE.TaskEither<UnknownError, number> {
    return TE.tryCatch(
      () =>
        this.dbClient.cx.workflow.count({
          where: {organizationId: context.organizationId, status: {notIn: WORKFLOW_TERMINAL_STATUSES}}
        }),
      error => this.mapUnknownError(error, "count")
    )
  }

  getParentWorkflowTemplate(
    context: TenantContext,
    workflowId: string
  ): TE.TaskEither<WorkflowGetParentTemplateError, string> {
    return pipe(
      TE.tryCatch<UnknownError, {readonly workflowTemplateId: string} | null>(
        () =>
          this.dbClient.cx.workflow.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: workflowId}},
            select: {workflowTemplateId: true}
          }),
        error => this.mapUnknownError(error, "get parent template")
      ),
      TE.chainW(row => (row ? TE.right(row.workflowTemplateId) : TE.left("workflow_not_found" as const)))
    )
  }

  findExpiredWorkflows(
    context: TenantContext,
    expiresBefore: Date,
    limit = 1000
  ): TE.TaskEither<UnknownError, string[]> {
    return pipe(
      TE.tryCatch<UnknownError, ReadonlyArray<{id: string}>>(
        () =>
          this.dbClient.cx.workflow.findMany({
            where: {
              organizationId: context.organizationId,
              status: {notIn: WORKFLOW_TERMINAL_STATUSES},
              expiresAt: {lt: expiresBefore},
              recalculationRequired: false
            },
            select: {id: true},
            orderBy: [{expiresAt: "asc"}, {id: "asc"}],
            take: limit
          }),
        error => this.mapUnknownError(error, "find expired")
      ),
      TE.map(rows => rows.map(row => row.id))
    )
  }

  markWorkflowsAsRecalculationRequired(
    context: TenantContext,
    workflowIds: string[]
  ): TE.TaskEither<UnknownError, void> {
    if (workflowIds.length === 0) return TE.right(undefined)
    return TE.map(() => undefined)(
      TE.tryCatch(
        () =>
          this.dbClient.cx.workflow.updateMany({
            where: {organizationId: context.organizationId, id: {in: workflowIds}},
            data: {recalculationRequired: true}
          }),
        error => this.mapUnknownError(error, "mark recalculation")
      )
    )
  }

  private get(
    context: TenantContext,
    where: Prisma.WorkflowWhereUniqueInput,
    include?: WorkflowDecoratorSelector
  ): TE.TaskEither<WorkflowGetError, WorkflowResult> {
    if (include?.workflowTemplate)
      return pipe(
        TE.tryCatch<UnknownError, WorkflowWithTemplate | null>(
          () => this.dbClient.cx.workflow.findUnique({where, include: {workflowTemplates: true}}),
          error => this.mapUnknownError(error, "get with template")
        ),
        TE.chainW(row => (row ? this.mapWorkflowWithTemplate(context, row) : TE.left("workflow_not_found" as const)))
      )

    return pipe(
      TE.tryCatch<UnknownError, PrismaWorkflow | null>(
        () => this.dbClient.cx.workflow.findUnique({where}),
        error => this.mapUnknownError(error, "get")
      ),
      TE.chainW(row => (row ? TE.fromEither(mapWorkflow(row)) : TE.left("workflow_not_found" as const)))
    )
  }

  private update(
    context: TenantContext,
    workflowId: string,
    occCheck: bigint | undefined,
    data: ConcurrentSafeWorkflowUpdateData | ConcurrentUnsafeWorkflowUpdateData,
    include?: WorkflowDecoratorSelector
  ): TE.TaskEither<WorkflowUpdateError, WorkflowResult> {
    return pipe(
      TE.tryCatch<UnknownError, {count: number}>(
        () =>
          this.dbClient.cx.workflow.updateMany({
            where: {
              organizationId: context.organizationId,
              id: workflowId,
              ...(occCheck === undefined ? {} : {occ: occCheck})
            },
            data: {
              ...("status" in data && data.status !== undefined ? {status: data.status} : {}),
              recalculationRequired: data.recalculationRequired,
              updatedAt: "updatedAt" in data ? data.updatedAt : new Date(),
              ...(occCheck === undefined ? {} : {occ: {increment: 1}})
            }
          }),
        error => this.mapUnknownError(error, "update")
      ),
      TE.chainW(result =>
        result.count === 1
          ? this.get(context, {organizationId_id: {organizationId: context.organizationId, id: workflowId}}, include)
          : TE.left("concurrency_error" as const)
      )
    )
  }

  private mapWorkflowWithTemplate(
    context: TenantContext,
    row: WorkflowWithTemplate
  ): TE.TaskEither<WorkflowGetError, WorkflowResult> {
    return pipe(
      this.decryptTemplate(context, row.workflowTemplates),
      TE.chainEitherKW(template => {
        const workflow = mapWorkflow(row)
        return E.isLeft(workflow) ? workflow : E.right({...workflow.right, workflowTemplate: template})
      })
    )
  }

  private decryptTemplate(
    context: TenantContext,
    row: PrismaWorkflowTemplate
  ): TE.TaskEither<EncryptionError, Versioned<WorkflowTemplate>> {
    if (!row.encActions) return TE.left("decryption_failed")
    return pipe(
      this.tenantEncryption.decrypt(encryptionContext(context, row.id), row.encActions),
      TE.mapLeft(() => "decryption_failed" as const),
      TE.chainEitherKW(plaintext => {
        const actions = E.tryCatch(
          () => JSON.parse(plaintext) as unknown,
          () => "decryption_failed" as const
        )
        if (E.isLeft(actions)) return actions
        const template = WorkflowTemplateFactory.validate({
          id: row.id,
          organizationId: row.organizationId,
          name: row.name,
          version: row.version,
          description: row.description ?? undefined,
          approvalRule: row.approvalRule,
          actions: actions.right,
          defaultExpiresInHours: row.defaultExpiresInHours ?? undefined,
          status: row.status,
          allowVotingOnDeprecatedTemplate: row.allowVotingOnDeprecatedTemplate,
          spaceId: row.spaceId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt
        })
        return E.isLeft(template) ? E.left("decryption_failed" as const) : E.right({...template.right, occ: row.occ})
      })
    )
  }

  private listWhere(
    context: TenantContext,
    request: ListWorkflowsRequestRepo<WorkflowDecoratorSelector>
  ): Prisma.WorkflowWhereInput {
    const filters = request.filters
    return {
      organizationId: context.organizationId,
      ...(filters?.includeOnlyNonTerminalState ? {status: {notIn: WORKFLOW_TERMINAL_STATUSES}} : {}),
      ...(filters?.workflowTemplateId ? {workflowTemplateId: filters.workflowTemplateId} : {}),
      ...(filters?.workflowTemplateName ? {workflowTemplates: {is: {name: filters.workflowTemplateName}}} : {})
    }
  }

  private mapCreateError(error: unknown): "workflow_already_exists" | UnknownError {
    if (isPrismaUniqueConstraintError(error, ["organization_id", "name"], "workflows_organization_name_unique"))
      return "workflow_already_exists"
    return this.mapUnknownError(error, "create")
  }

  private mapUnknownError(error: unknown, operation: string): UnknownError {
    Logger.error(`Workflow repository ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }
}

function mapWorkflow(row: PrismaWorkflow): E.Either<"workflow_status_invalid", Versioned<Workflow>> {
  const workflow = WorkflowFactory.validate({
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
  })
  return E.isLeft(workflow) ? E.left("workflow_status_invalid") : E.right({...workflow.right, occ: row.occ})
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

function toOrderBy(
  sort: ListWorkflowsRequestRepo<WorkflowDecoratorSelector>["sort"]
): Prisma.WorkflowOrderByWithRelationInput[] {
  if (!sort || sort.length === 0) return [{updatedAt: "desc"}, {id: "asc"}]
  const orderBy: Prisma.WorkflowOrderByWithRelationInput[] = []
  for (const item of sort)
    if (item.param === "createdAt") orderBy.push({createdAt: item.order})
    else orderBy.push({updatedAt: item.order})

  return [...orderBy, {id: "asc"}]
}
