import {
  WorkflowTemplate,
  WorkflowTemplateValidationError,
  ApprovalRule,
  ApprovalRuleType,
  WorkflowTemplateStatus,
  WorkflowTemplateFactory,
  WorkflowTemplateSummary,
  BoundaryError,
  TenantContext,
  Versioned
} from "@domain"
import {chainNullableToLeft} from "@external/database/utils"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, WorkflowTemplate as PrismaWorkflowTemplate} from "@prisma/client"
import {
  WorkflowTemplateCreateExecutionError,
  WorkflowTemplateGetError,
  WorkflowTemplateRepository,
  WorkflowTemplateUpdateExecutionError,
  ListWorkflowTemplatesRequestRepo,
  ListWorkflowTemplatesResponse,
  WorkflowTemplateGetActiveError,
  WorkflowTemplateGetParentSpaceError,
  WorkflowTemplateSummaryGetError,
  DeferredWorkflowTemplateWrite,
  DeferredWorkflowTemplate
} from "@services"
import {UnknownError} from "@services/error"
import {CryptoError} from "@services/encryption/interfaces"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import * as O from "fp-ts/Option"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import * as E from "fp-ts/Either"
import {SortBy, SortDirection} from "@approvio/api"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {WorkflowTemplateTenantClient} from "./tenant-database-clients"
import {fromPromise} from "./repository-operation"

type Identifier = IdIdentifier | NameVersionIdentifier

interface IdIdentifier {
  id: string
  type: "id"
}

interface NameVersionIdentifier {
  type: "name_version"
  name: string
  version: number
}

@Injectable()
export class WorkflowTemplateDbRepository implements WorkflowTemplateRepository {
  constructor(
    private readonly dbClient: WorkflowTemplateTenantClient,
    private readonly encryptionService: TenantEncryptionService
  ) {}

  private decryptTemplate(
    context: TenantContext,
    template: PrismaWorkflowTemplate
  ): TaskEither<CryptoError | WorkflowTemplateValidationError, Versioned<WorkflowTemplate>> {
    return pipe(
      this.decryptActions(context, template),
      TE.chainEitherKW(actions => mapToDomainVersionedWorkflowTemplate(template, actions))
    )
  }

  private decryptActions(context: TenantContext, template: PrismaWorkflowTemplate): TaskEither<CryptoError, unknown> {
    if (template.encActions === null) return TE.left("unsupported_format")
    return pipe(
      this.encryptionService.decrypt(buildEncryptionContext(context, template.id), template.encActions),
      TE.chainEitherKW(plaintext =>
        E.tryCatch(
          () => JSON.parse(plaintext) as unknown,
          error => {
            Logger.error(`Failed to parse decrypted actions JSON: ${String(error)}`, error)
            return "decryption_failed" as const
          }
        )
      )
    )
  }

  createDeferredCreateExecution(
    context: TenantContext,
    data: WorkflowTemplate
  ): TaskEither<
    WorkflowTemplateCreateExecutionError | WorkflowTemplateValidationError,
    DeferredWorkflowTemplateWrite<WorkflowTemplateCreateExecutionError | WorkflowTemplateValidationError>
  > {
    return pipe(
      this.encryptActions(context, data),
      TE.map(
        encActions => () =>
          pipe(
            this.persistWorkflowTemplate(data, encActions),
            TE.chainEitherKW(record => mapToDomainVersionedWorkflowTemplate(record, data.actions))
          )
      )
    )
  }

  getParentSpace(context: TenantContext, templateId: string): TaskEither<WorkflowTemplateGetParentSpaceError, string> {
    return pipe(
      fromPromise<UnknownError, {spaceId: string} | null>(
        () =>
          this.dbClient.cx.workflowTemplate.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: templateId}},
            select: {spaceId: true}
          }),
        error => {
          Logger.error(`Error while retrieving parent space for workflow template ${templateId}. Unknown error`, error)
          return "unknown_error" as const
        }
      ),
      chainNullableToLeft("workflow_template_not_found" as const),
      TE.map(template => template.spaceId)
    )
  }
  /**
   * Gets a workflow template by its UUID.
   * @param templateId The ID of the workflow template.
   * @returns A TaskEither with the deferred versioned workflow template or an error if not found.
   */
  getWorkflowTemplateById(
    context: TenantContext,
    templateId: string
  ): TaskEither<WorkflowTemplateGetError, DeferredWorkflowTemplate<Versioned<WorkflowTemplate>>> {
    const identifier: Identifier = {type: "id", id: templateId}
    return this.getWorkflowTemplate(context, identifier)
  }

  getWorkflowTemplateByNameAndVersion(
    context: TenantContext,
    templateName: string,
    version: number
  ): TaskEither<WorkflowTemplateGetError, DeferredWorkflowTemplate<Versioned<WorkflowTemplate>>> {
    const identifier: Identifier = {type: "name_version", name: templateName, version}
    return this.getWorkflowTemplate(context, identifier)
  }

  getActiveWorkflowTemplateByName(
    context: TenantContext,
    templateName: string
  ): TaskEither<WorkflowTemplateGetActiveError, DeferredWorkflowTemplate<Versioned<WorkflowTemplate>>> {
    const snapshotContext = {organizationId: context.organizationId}
    return pipe(
      fromPromise<UnknownError, PrismaWorkflowTemplate[]>(
        () =>
          this.dbClient.cx.workflowTemplate.findMany({
            where: {organizationId: context.organizationId, name: templateName, status: WorkflowTemplateStatus.ACTIVE}
          }),
        error => {
          Logger.error(`Error while retrieving active workflow template by name ${templateName}. Unknown error`, error)
          return "unknown_error" as const
        }
      ),
      TE.chainW(records => {
        const [record] = records
        if (!record) return TE.left("active_workflow_template_not_found" as const)
        if (records.length > 1) {
          Logger.error(`Multiple active workflow templates found for name ${templateName}`)
          return TE.left("unknown_error" as const)
        }
        return TE.right(deferWorkflowTemplate(() => this.decryptTemplate(snapshotContext, record)()))
      })
    )
  }

  getMostRecentNonActiveWorkflowTemplateByName(
    context: TenantContext,
    templateName: string
  ): TaskEither<WorkflowTemplateGetError, DeferredWorkflowTemplate<O.Option<Versioned<WorkflowTemplate>>>> {
    const snapshotContext = {organizationId: context.organizationId}
    return pipe(
      fromPromise<UnknownError, PrismaWorkflowTemplate | null>(
        () =>
          this.dbClient.cx.workflowTemplate.findFirst({
            where: {
              organizationId: context.organizationId,
              name: templateName,
              status: {not: WorkflowTemplateStatus.ACTIVE}
            },
            orderBy: {version: "desc"}
          }),
        error => {
          Logger.error(
            `Error while retrieving non-active workflow templates by name ${templateName}. Unknown error`,
            error
          )
          return "unknown_error" as const
        }
      ),
      TE.chainW(record => {
        if (!record) return TE.right(deferWorkflowTemplate(TE.right(O.none)))
        return TE.right(
          deferWorkflowTemplate(() => pipe(this.decryptTemplate(snapshotContext, record), TE.map(O.some))())
        )
      })
    )
  }

  createDeferredUpdateExecution(
    context: TenantContext,
    template: Versioned<WorkflowTemplate>
  ): TaskEither<
    WorkflowTemplateUpdateExecutionError,
    DeferredWorkflowTemplateWrite<WorkflowTemplateUpdateExecutionError>
  > {
    return pipe(
      this.encryptActions(context, template),
      TE.map((encActions: string) => () => this.updateWorkflowTemplateTask(template, encActions))
    )
  }

  listWorkflowTemplates(
    context: TenantContext,
    request: ListWorkflowTemplatesRequestRepo
  ): TaskEither<BoundaryError | WorkflowTemplateValidationError | UnknownError, ListWorkflowTemplatesResponse> {
    return pipe(
      fromPromise(
        async () => {
          const skip = (request.pagination.page - 1) * request.pagination.limit

          const where: Prisma.WorkflowTemplateWhereInput = {organizationId: context.organizationId}

          if (request.search)
            if (request.searchMode === "EXACT") where.name = request.search
            else where.name = {contains: request.search, mode: "insensitive"}

          if (request.filters?.spaceId) where.spaceId = request.filters.spaceId
          else if (request.filters?.spaceName)
            where.spaces = {
              name: request.filters.spaceName
            }

          if (request.filters?.status) where.status = {in: [...request.filters.status]}

          const orderBy: Prisma.WorkflowTemplateOrderByWithRelationInput[] = []
          const sortItems = request.sort ?? []

          if (sortItems.length > 0)
            for (const {field, direction} of sortItems) {
              const dir = direction === SortDirection.DESC ? "desc" : "asc"

              if (field === SortBy.CREATED_AT) orderBy.push({createdAt: dir})
              else if (field === SortBy.UPDATED_AT) orderBy.push({updatedAt: dir})
              else if (field === SortBy.VERSION) orderBy.push({version: dir})
            }

          if (orderBy.length === 0) orderBy.push({createdAt: "desc"})

          const [templates, total] = await Promise.all([
            this.dbClient.cx.workflowTemplate.findMany({
              skip,
              take: request.pagination.limit,
              orderBy,
              where,
              select: {
                organizationId: true,
                id: true,
                name: true,
                version: true,
                description: true,
                status: true,
                createdAt: true,
                updatedAt: true
              }
            }),
            this.dbClient.cx.workflowTemplate.count({where})
          ])

          return {templates, total}
        },
        error => {
          Logger.error("Error while listing workflow templates. Unknown error", error)
          return "unknown_error" as const
        }
      ),
      TE.chainEitherKW(({templates, total}) =>
        pipe(
          templates,
          E.traverseArray(mapTemplateSummary),
          E.map(summaries => ({
            templates: summaries,
            pagination: {
              total,
              page: request.pagination.page,
              limit: request.pagination.limit
            }
          }))
        )
      )
    )
  }

  createDeferredUpdateAndCreateExecution(
    context: TenantContext,
    data: {existingTemplate: Versioned<WorkflowTemplate>; newTemplate: WorkflowTemplate}
  ): TaskEither<
    WorkflowTemplateUpdateExecutionError | WorkflowTemplateCreateExecutionError,
    DeferredWorkflowTemplateWrite<WorkflowTemplateUpdateExecutionError | WorkflowTemplateCreateExecutionError>
  > {
    return pipe(
      TE.Do,
      TE.bind("existingActions", () => this.encryptActions(context, data.existingTemplate)),
      TE.bind("newActions", () => this.encryptActions(context, data.newTemplate)),
      TE.map(
        ({existingActions, newActions}) =>
          () =>
            pipe(
              this.updateWorkflowTemplateTask(data.existingTemplate, existingActions),
              TE.chainW(() => this.persistWorkflowTemplate(data.newTemplate, newActions)),
              TE.chainEitherKW(record => mapToDomainVersionedWorkflowTemplate(record, data.newTemplate.actions))
            )
      )
    )
  }

  getWorkflowTemplatesParentsByNames(
    context: TenantContext,
    templateNames: ReadonlyArray<string>
  ): TaskEither<BoundaryError | "workflow_template_not_found", ReadonlyMap<string, string>> {
    const names = [...new Set(templateNames)]
    if (names.length === 0) return TE.right(new Map())
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.workflowTemplate.findMany({
            where: {organizationId: context.organizationId, name: {in: names}},
            distinct: ["name"],
            select: {name: true, spaceId: true}
          }),
        error => {
          Logger.error("Error while retrieving workflow template space mappings. Unknown error", error)
          return "workflow_template_not_found" as const
        }
      ),
      TE.chainW(records => {
        if (records.length !== names.length) return TE.left("workflow_template_not_found" as const)
        return TE.right(new Map<string, string>(records.map(record => [record.name, record.spaceId] as const)))
      })
    )
  }

  countUniqueWorkflowTemplatesBySpaceId(context: TenantContext, spaceId: string): TaskEither<UnknownError, number> {
    return pipe(
      fromPromise<UnknownError, ReadonlyArray<{name: string}>>(
        () =>
          this.dbClient.cx.workflowTemplate.findMany({
            where: {organizationId: context.organizationId, spaceId},
            distinct: ["name"],
            select: {name: true}
          }),
        error => {
          Logger.error(`Error counting workflow templates in space ${spaceId}`, error)
          return "unknown_error" as const
        }
      ),
      TE.map(rows => rows.length)
    )
  }

  private updateWorkflowTemplateTask(
    template: Versioned<WorkflowTemplate>,
    encActions: string
  ): TaskEither<WorkflowTemplateUpdateExecutionError, Versioned<WorkflowTemplate>> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.workflowTemplate.update({
            where: {organizationId_id: {organizationId: template.organizationId, id: template.id}, occ: template.occ},
            data: {...mapWorkflowTemplateToPrisma(template), encActions, occ: {increment: 1}}
          }),
        error => {
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.WorkflowTemplate)) return "concurrency_error" as const
          return this.mapUpdateError(error)
        }
      ),
      TE.chainEitherKW(record => mapToDomainVersionedWorkflowTemplate(record, template.actions))
    )
  }

  private getWorkflowTemplate(
    context: TenantContext,
    identifier: Identifier
  ): TaskEither<WorkflowTemplateGetError, DeferredWorkflowTemplate<Versioned<WorkflowTemplate>>> {
    const snapshotContext = {organizationId: context.organizationId}
    return pipe(
      identifier,
      TE.right,
      TE.chainW(this.getObjectTask(context)),
      chainNullableToLeft("workflow_template_not_found" as const),
      TE.map(record => deferWorkflowTemplate(() => this.decryptTemplate(snapshotContext, record)()))
    )
  }

  private getObjectTask(
    context: TenantContext
  ): (identifier: Identifier) => TaskEither<WorkflowTemplateGetError, PrismaWorkflowTemplate | null> {
    return identifier => {
      const where: Prisma.WorkflowTemplateWhereUniqueInput =
        identifier.type === "id"
          ? {organizationId_id: {organizationId: context.organizationId, id: identifier.id}}
          : {
              organizationId_name_version: {
                organizationId: context.organizationId,
                name: identifier.name,
                version: identifier.version
              }
            }

      return fromPromise(
        () => this.dbClient.cx.workflowTemplate.findUnique({where}),
        error => {
          Logger.error(`Error while retrieving workflow template by ${identifier.type}. Unknown error`, error)
          return "unknown_error" as const
        }
      )
    }
  }

  private persistWorkflowTemplate(
    template: WorkflowTemplate,
    encActions: string
  ): TaskEither<WorkflowTemplateCreateExecutionError, PrismaWorkflowTemplate> {
    return fromPromise(
      () =>
        this.dbClient.cx.workflowTemplate.create({
          data: {
            ...mapWorkflowTemplateToPrisma(template),
            organizations: {connect: {id: template.organizationId}},
            encActions,
            occ: POSTGRES_BIGINT_LOWER_BOUND
          }
        }),
      error => this.mapCreateError(error)
    )
  }

  getWorkflowTemplateSummaryById(
    context: TenantContext,
    templateId: string
  ): TaskEither<WorkflowTemplateSummaryGetError, WorkflowTemplateSummary> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.workflowTemplate.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: templateId}},
            select: {
              organizationId: true,
              id: true,
              name: true,
              version: true,
              description: true,
              status: true,
              createdAt: true,
              updatedAt: true,
              defaultExpiresInHours: true
            }
          }),
        error => this.mapUnknownError(error, "get template summary")
      ),
      chainNullableToLeft("workflow_template_not_found" as const),
      TE.chainEitherKW(mapTemplateSummary)
    )
  }

  private encryptActions(context: TenantContext, template: WorkflowTemplate): TaskEither<CryptoError, string> {
    return pipe(
      TE.fromEither(
        E.tryCatch(
          () => JSON.stringify(template.actions),
          () => "encryption_failed" as const
        )
      ),
      TE.chainW(plaintext => this.encryptionService.encrypt(buildEncryptionContext(context, template.id), plaintext))
    )
  }

  private mapCreateError(error: unknown): WorkflowTemplateCreateExecutionError {
    if (
      isPrismaUniqueConstraintError(
        error,
        ["organization_id", "name", "version"],
        "workflow_templates_organization_name_version_unique"
      )
    )
      return "workflow_template_already_exists"
    return this.mapUnknownError(error, "create template")
  }

  private mapUpdateError(error: unknown): WorkflowTemplateUpdateExecutionError {
    if (
      isPrismaUniqueConstraintError(
        error,
        ["organization_id", "name", "version"],
        "workflow_templates_organization_name_version_unique"
      )
    )
      return "workflow_template_already_exists"
    return this.mapUnknownError(error, "update template")
  }

  private mapUnknownError(error: unknown, operation: string): UnknownError {
    Logger.error(`Workflow template ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }
}

function mapApprovalRuleToJsonb(approvalRule: ApprovalRule): Prisma.InputJsonValue {
  switch (approvalRule.type) {
    case ApprovalRuleType.AND:
      return {
        type: "AND",
        rules: approvalRule.rules.map(rule => mapApprovalRuleToJsonb(rule))
      }
    case ApprovalRuleType.OR:
      return {
        type: "OR",
        rules: approvalRule.rules.map(rule => mapApprovalRuleToJsonb(rule))
      }
    case ApprovalRuleType.GROUP_REQUIREMENT:
      return {
        type: "GROUP_REQUIREMENT",
        groupId: approvalRule.groupId,
        minCount: approvalRule.minCount,
        ...(approvalRule.requireHighPrivilege !== undefined && {
          requireHighPrivilege: approvalRule.requireHighPrivilege
        })
      }
  }
}

function mapWorkflowTemplateToPrisma(
  template: WorkflowTemplate
): Omit<Prisma.WorkflowTemplateCreateInput, "organizations" | "workflows" | "encActions" | "occ"> {
  return {
    id: template.id,
    name: template.name,
    version: template.version,
    description: template.description ?? null,
    approvalRule: mapApprovalRuleToJsonb(template.approvalRule),
    defaultExpiresInHours: template.defaultExpiresInHours ?? null,
    status: template.status,
    allowVotingOnDeprecatedTemplate: template.allowVotingOnDeprecatedTemplate,
    spaces: {connect: {organizationId_id: {organizationId: template.organizationId, id: template.spaceId}}},
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  }
}

function buildEncryptionContext(context: TenantContext, templateId: string) {
  return {
    organizationId: context.organizationId,
    resourceType: "workflow_template" as const,
    resourceId: templateId,
    field: "actions" as const,
    formatVersion: 1 as const
  }
}

function mapToDomainVersionedWorkflowTemplate(
  record: PrismaWorkflowTemplate,
  actions: unknown
): E.Either<WorkflowTemplateValidationError, Versioned<WorkflowTemplate>> {
  return pipe(
    WorkflowTemplateFactory.validate({
      id: record.id,
      organizationId: record.organizationId,
      name: record.name,
      version: record.version,
      description: record.description ?? undefined,
      approvalRule: record.approvalRule,
      actions,
      defaultExpiresInHours: record.defaultExpiresInHours ?? undefined,
      status: record.status,
      allowVotingOnDeprecatedTemplate: record.allowVotingOnDeprecatedTemplate,
      spaceId: record.spaceId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }),
    E.map(template => ({...template, occ: record.occ}))
  )
}

type WorkflowTemplateSummaryRecord = Pick<
  PrismaWorkflowTemplate,
  "organizationId" | "id" | "name" | "version" | "description" | "status" | "createdAt" | "updatedAt"
> &
  Partial<Pick<PrismaWorkflowTemplate, "defaultExpiresInHours">>

function mapTemplateSummary(
  template: WorkflowTemplateSummaryRecord
): E.Either<WorkflowTemplateValidationError, WorkflowTemplateSummary> {
  return WorkflowTemplateFactory.validateSummary({
    organizationId: template.organizationId,
    id: template.id,
    name: template.name,
    version: template.version,
    description: template.description ?? undefined,
    status: template.status,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    defaultExpiresInHours: template.defaultExpiresInHours ?? undefined
  })
}

/**
 * Decrypts and validates one fetched snapshot only when resolve is called.
 * Concurrent callers share the same promise; success retains the resolved object
 * and its original OCC. Failures clear the promise so a later call can retry.
 * Each fetched snapshot owns its cache; this does not refresh the database row.
 */
function deferWorkflowTemplate<Result>(
  task: TaskEither<CryptoError | WorkflowTemplateValidationError, Result>
): DeferredWorkflowTemplate<Result> {
  let pending: ReturnType<typeof task> | undefined
  return {
    resolve: () => {
      pending ??= Promise.resolve()
        .then(task)
        .catch(() => E.left("decryption_failed" as const))
        .then(result => {
          // Return this failure to current callers, but let the next resolve retry
          // the same fetched snapshot instead of reusing a cached failure.
          if (E.isLeft(result)) pending = undefined
          return result
        })
      return pending
    }
  }
}
