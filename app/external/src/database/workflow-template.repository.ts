import {Injectable, Logger} from "@nestjs/common"
import {
  ApprovalRule,
  ApprovalRuleType,
  BoundaryError,
  TenantContext,
  Versioned,
  WorkflowAction,
  WorkflowActionType,
  WorkflowTemplate,
  WorkflowTemplateFactory,
  WorkflowTemplateSummary,
  WorkflowTemplateStatus,
  WorkflowTemplateValidationError
} from "@domain"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {
  WorkflowTemplateCreateExecutionError,
  ListWorkflowTemplatesRequestRepo,
  ListWorkflowTemplatesResponse,
  WorkflowTemplateGetActiveError,
  WorkflowTemplateGetError,
  WorkflowTemplateSummaryGetError,
  WorkflowTemplateGetParentSpaceError,
  WorkflowTemplateRepository,
  DeferredWorkflowTemplateWrite,
  DeferredWorkflowTemplate,
  WorkflowTemplateUpdateExecutionError
} from "@services"
import {EncryptionError, UnknownError} from "@services/error"
import {Prisma, WorkflowTemplate as PrismaWorkflowTemplate} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as O from "fp-ts/Option"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {SortBy, SortDirection} from "@approvio/api"
import {WorkflowTemplateTenantClient} from "./tenant-database-clients"
import {isPrismaUniqueConstraintError} from "./errors"

@Injectable()
export class WorkflowTemplateDbRepository implements WorkflowTemplateRepository {
  constructor(
    private readonly dbClient: WorkflowTemplateTenantClient,
    private readonly tenantEncryption: TenantEncryptionService
  ) {}

  createDeferredCreateExecution(
    context: TenantContext,
    data: WorkflowTemplate
  ): TaskEither<
    WorkflowTemplateCreateExecutionError | WorkflowTemplateValidationError,
    DeferredWorkflowTemplateWrite<WorkflowTemplateCreateExecutionError | WorkflowTemplateValidationError>
  > {
    if (data.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    return pipe(
      this.encryptActions(context, data),
      TE.map(
        encActions => () =>
          pipe(
            this.createPreparedTemplate(context, data, encActions),
            TE.chainEitherKW(record => toDomainTemplate(record, data.actions))
          )
      )
    )
  }

  getWorkflowTemplateSummaryById(
    context: TenantContext,
    templateId: string
  ): TaskEither<WorkflowTemplateSummaryGetError, WorkflowTemplateSummary> {
    return pipe(
      TE.tryCatch(
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
      TE.chainW(record =>
        record ? TE.fromEither(mapTemplateSummary(record)) : TE.left("workflow_template_not_found" as const)
      )
    )
  }

  getParentSpace(context: TenantContext, templateId: string): TaskEither<WorkflowTemplateGetParentSpaceError, string> {
    return pipe(
      TE.tryCatch<UnknownError, {spaceId: string} | null>(
        () =>
          this.dbClient.cx.workflowTemplate.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: templateId}},
            select: {spaceId: true}
          }),
        error => this.mapUnknownError(error, "get parent space")
      ),
      TE.chainW(record => (record ? TE.right(record.spaceId) : TE.left("workflow_template_not_found" as const)))
    )
  }

  getWorkflowTemplateById(
    context: TenantContext,
    templateId: string
  ): TaskEither<WorkflowTemplateGetError, DeferredWorkflowTemplate<Versioned<WorkflowTemplate>>> {
    return this.getOne(context, {organizationId_id: {organizationId: context.organizationId, id: templateId}})
  }

  getWorkflowTemplateByNameAndVersion(
    context: TenantContext,
    templateName: string,
    version: number
  ): TaskEither<WorkflowTemplateGetError, DeferredWorkflowTemplate<Versioned<WorkflowTemplate>>> {
    return this.getOne(context, {
      organizationId_name_version: {organizationId: context.organizationId, name: templateName, version}
    })
  }

  getActiveWorkflowTemplateByName(
    context: TenantContext,
    templateName: string
  ): TaskEither<WorkflowTemplateGetActiveError, DeferredWorkflowTemplate<Versioned<WorkflowTemplate>>> {
    const snapshotContext = {organizationId: context.organizationId}
    return pipe(
      TE.tryCatch<UnknownError, PrismaWorkflowTemplate[]>(
        () =>
          this.dbClient.cx.workflowTemplate.findMany({
            where: {organizationId: context.organizationId, name: templateName, status: WorkflowTemplateStatus.ACTIVE}
          }),
        error => this.mapUnknownError(error, "get active template")
      ),
      TE.chainW(records => {
        const [record] = records
        if (!record) return TE.left("active_workflow_template_not_found" as const)
        if (records.length > 1) return TE.left("unknown_error" as const)
        return TE.right(deferWorkflowTemplate(() => this.decryptAndMap(snapshotContext, record)()))
      })
    )
  }

  getMostRecentNonActiveWorkflowTemplateByName(
    context: TenantContext,
    templateName: string
  ): TaskEither<WorkflowTemplateGetError, DeferredWorkflowTemplate<O.Option<Versioned<WorkflowTemplate>>>> {
    const snapshotContext = {organizationId: context.organizationId}
    return pipe(
      TE.tryCatch<UnknownError, PrismaWorkflowTemplate[]>(
        () =>
          this.dbClient.cx.workflowTemplate.findMany({
            where: {
              organizationId: context.organizationId,
              name: templateName,
              status: {not: WorkflowTemplateStatus.ACTIVE}
            },
            orderBy: {version: "desc"},
            take: 1
          }),
        error => this.mapUnknownError(error, "get most recent non-active template")
      ),
      TE.chainW(records => {
        const [record] = records
        if (!record) return TE.right(deferWorkflowTemplate(TE.right(O.none)))
        return TE.right(
          deferWorkflowTemplate(() => pipe(this.decryptAndMap(snapshotContext, record), TE.map(O.some))())
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
    if (template.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    return pipe(
      this.encryptActions(context, template),
      TE.map((encActions: string) => () => this.updatePreparedTemplate(context, template, encActions))
    )
  }

  listWorkflowTemplates(
    context: TenantContext,
    request: ListWorkflowTemplatesRequestRepo
  ): TaskEither<BoundaryError | WorkflowTemplateValidationError | UnknownError, ListWorkflowTemplatesResponse> {
    if (request.pagination.page < 1 || request.pagination.limit < 1) return TE.left("unknown_error")

    const where: Prisma.WorkflowTemplateWhereInput = {organizationId: context.organizationId}
    if (request.search)
      where.name = request.searchMode === "EXACT" ? request.search : {contains: request.search, mode: "insensitive"}
    if (request.filters?.spaceId) where.spaceId = request.filters.spaceId
    else if (request.filters?.spaceName) where.spaces = {is: {name: request.filters.spaceName}}
    if (request.filters?.status) where.status = {in: [...request.filters.status]}

    const orderBy = toOrderBy(request.sort)
    return pipe(
      TE.tryCatch<UnknownError, {templates: WorkflowTemplateSummaryRecord[]; total: number}>(
        async () => {
          const [templates, total] = await Promise.all([
            this.dbClient.cx.workflowTemplate.findMany({
              where,
              orderBy,
              skip: (request.pagination.page - 1) * request.pagination.limit,
              take: request.pagination.limit,
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
        error => this.mapUnknownError(error, "list templates")
      ),
      TE.chainEitherKW(({templates, total}) => {
        const summaries = mapTemplateSummaries(templates)
        if (E.isLeft(summaries)) return summaries
        return E.right({
          templates: summaries.right,
          pagination: {total, page: request.pagination.page, limit: request.pagination.limit}
        })
      })
    )
  }

  createDeferredUpdateAndCreateExecution(
    context: TenantContext,
    data: {existingTemplate: Versioned<WorkflowTemplate>; newTemplate: WorkflowTemplate}
  ): TaskEither<
    WorkflowTemplateUpdateExecutionError | WorkflowTemplateCreateExecutionError,
    DeferredWorkflowTemplateWrite<WorkflowTemplateUpdateExecutionError | WorkflowTemplateCreateExecutionError>
  > {
    if (
      data.existingTemplate.organizationId !== context.organizationId ||
      data.newTemplate.organizationId !== context.organizationId
    )
      return TE.left("organization_mismatch")

    return pipe(
      TE.Do,
      TE.bind("existingActions", () => this.encryptActions(context, data.existingTemplate)),
      TE.bind("newActions", () => this.encryptActions(context, data.newTemplate)),
      TE.map(
        ({existingActions, newActions}) =>
          () =>
            pipe(
              this.updatePreparedTemplate(context, data.existingTemplate, existingActions),
              TE.chainW(() => this.createPreparedTemplate(context, data.newTemplate, newActions)),
              TE.chainEitherKW(record => toDomainTemplate(record, data.newTemplate.actions))
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
      TE.tryCatch<"workflow_template_not_found", ReadonlyArray<{name: string; spaceId: string}>>(
        () =>
          this.dbClient.cx.workflowTemplate.findMany({
            where: {organizationId: context.organizationId, name: {in: names}},
            distinct: ["name"],
            select: {name: true, spaceId: true}
          }),
        error => {
          Logger.error(
            "Workflow template get template parents failed",
            error instanceof Error ? error.name : "non_error"
          )
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
      TE.tryCatch<UnknownError, ReadonlyArray<{name: string}>>(
        () =>
          this.dbClient.cx.workflowTemplate.findMany({
            where: {organizationId: context.organizationId, spaceId},
            distinct: ["name"],
            select: {name: true}
          }),
        error => this.mapUnknownError(error, "count unique templates")
      ),
      TE.map(rows => rows.length)
    )
  }

  private getOne(
    context: TenantContext,
    where: Prisma.WorkflowTemplateWhereUniqueInput
  ): TaskEither<WorkflowTemplateGetError, DeferredWorkflowTemplate<Versioned<WorkflowTemplate>>> {
    const snapshotContext = {organizationId: context.organizationId}
    return pipe(
      TE.tryCatch<UnknownError, PrismaWorkflowTemplate | null>(
        () => this.dbClient.cx.workflowTemplate.findUnique({where}),
        error => this.mapUnknownError(error, "get template")
      ),
      TE.chainW(record =>
        record
          ? TE.right(deferWorkflowTemplate(() => this.decryptAndMap(snapshotContext, record)()))
          : TE.left("workflow_template_not_found" as const)
      )
    )
  }

  private updatePreparedTemplate(
    context: TenantContext,
    template: Versioned<WorkflowTemplate>,
    encActions: string
  ): TaskEither<WorkflowTemplateUpdateExecutionError, Versioned<WorkflowTemplate>> {
    return pipe(
      TE.tryCatch<WorkflowTemplateUpdateExecutionError, {count: number}>(
        () =>
          this.dbClient.cx.workflowTemplate.updateMany({
            where: {organizationId: context.organizationId, id: template.id, occ: template.occ},
            data: {...toPrismaTemplate(template), encActions, occ: {increment: 1}, updatedAt: new Date()}
          }),
        error => this.mapUpdateError(error)
      ),
      TE.chainW(result => {
        if (result.count !== 1) return TE.left("concurrency_error" as const)
        return this.getUpdatedTemplate(context, template.id, template.actions)
      })
    )
  }

  private createPreparedTemplate(
    context: TenantContext,
    template: WorkflowTemplate,
    encActions: string
  ): TaskEither<WorkflowTemplateCreateExecutionError, PrismaWorkflowTemplate> {
    return pipe(
      this.validateApprovalGroups(context, template),
      TE.chainW(() =>
        TE.tryCatch<WorkflowTemplateCreateExecutionError, PrismaWorkflowTemplate>(
          () =>
            this.dbClient.cx.workflowTemplate.create({
              data: {
                ...toPrismaTemplate(template),
                organizationId: context.organizationId,
                encActions,
                occ: 0n
              }
            }),
          error => this.mapCreateError(error)
        )
      )
    )
  }

  private validateApprovalGroups(
    context: TenantContext,
    template: WorkflowTemplate
  ): TaskEither<UnknownError | "workflow_template_approval_group_not_found", void> {
    const groupIds = [...new Set(template.approvalRule.getVotingGroupIds())]
    // Execute in the deferred write transaction; RLS and the explicit predicate hide foreign groups.
    return pipe(
      TE.tryCatch(
        () => this.dbClient.cx.group.count({where: {organizationId: context.organizationId, id: {in: groupIds}}}),
        error => this.mapUnknownError(error, "validate approval groups")
      ),
      TE.chainW(count =>
        count === groupIds.length ? TE.right(undefined) : TE.left("workflow_template_approval_group_not_found" as const)
      )
    )
  }

  private getUpdatedTemplate(
    context: TenantContext,
    templateId: string,
    actions: readonly WorkflowAction[]
  ): TaskEither<WorkflowTemplateUpdateExecutionError, Versioned<WorkflowTemplate>> {
    return pipe(
      TE.tryCatch<UnknownError, PrismaWorkflowTemplate | null>(
        () =>
          this.dbClient.cx.workflowTemplate.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: templateId}}
          }),
        error => this.mapUnknownError(error, "read updated template")
      ),
      TE.chainW(record =>
        record ? TE.fromEither(toDomainTemplate(record, actions)) : TE.left("concurrency_error" as const)
      )
    )
  }

  private encryptActions(context: TenantContext, template: WorkflowTemplate): TaskEither<EncryptionError, string> {
    return TE.chainW((plaintext: string) =>
      TE.mapLeft(error => (error === "encryption_failed" ? "encryption_failed" : ("decryption_failed" as const)))(
        this.tenantEncryption.encrypt(encryptionContext(context, template.id), plaintext)
      )
    )(
      TE.fromEither(
        E.tryCatch(
          () => JSON.stringify(template.actions),
          () => "encryption_failed" as const
        )
      )
    )
  }

  private decryptAndMap(
    context: TenantContext,
    record: PrismaWorkflowTemplate
  ): TaskEither<EncryptionError | WorkflowTemplateValidationError, Versioned<WorkflowTemplate>> {
    if (!record.encActions) return TE.left("decryption_failed")
    return TE.chainW((plaintext: string) => {
      const parsed = E.tryCatch(
        () => JSON.parse(plaintext) as unknown,
        () => "decryption_failed" as const
      )
      if (E.isLeft(parsed)) return TE.left(parsed.left)
      return TE.fromEither(toDomainTemplate(record, parsed.right))
    })(
      TE.mapLeft(() => "decryption_failed" as const)(
        this.tenantEncryption.decrypt(encryptionContext(context, record.id), record.encActions)
      )
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return "concurrency_error"
    return this.mapUnknownError(error, "update template")
  }

  private mapUnknownError(error: unknown, operation: string): UnknownError {
    Logger.error(`Workflow template ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }
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

function toPrismaTemplate(
  template: WorkflowTemplate
): Omit<Prisma.WorkflowTemplateUncheckedCreateInput, "organizationId" | "encActions" | "occ"> {
  return {
    id: template.id,
    name: template.name,
    version: template.version,
    description: template.description ?? null,
    approvalRule: toApprovalRuleJson(template.approvalRule),
    defaultExpiresInHours: template.defaultExpiresInHours ?? null,
    status: template.status,
    allowVotingOnDeprecatedTemplate: template.allowVotingOnDeprecatedTemplate,
    spaceId: template.spaceId,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  }
}

function toApprovalRuleJson(rule: ApprovalRule): Prisma.InputJsonValue {
  switch (rule.type) {
    case ApprovalRuleType.AND:
      return {type: rule.type, rules: rule.rules.map(toApprovalRuleJson)}
    case ApprovalRuleType.OR:
      return {type: rule.type, rules: rule.rules.map(toApprovalRuleJson)}
    case ApprovalRuleType.GROUP_REQUIREMENT:
      return {
        type: rule.type,
        groupId: rule.groupId,
        minCount: rule.minCount,
        ...(rule.requireHighPrivilege === undefined ? {} : {requireHighPrivilege: rule.requireHighPrivilege})
      }
  }
}

function toDomainTemplate(
  record: PrismaWorkflowTemplate,
  actions: unknown
): E.Either<WorkflowTemplateValidationError, Versioned<WorkflowTemplate>> {
  const template = WorkflowTemplateFactory.validate({
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
  })
  return E.isLeft(template) ? E.left(template.left) : E.right({...template.right, occ: record.occ})
}

function toOrderBy(sort: ListWorkflowTemplatesRequestRepo["sort"]): Prisma.WorkflowTemplateOrderByWithRelationInput[] {
  if (!sort || sort.length === 0) return [{createdAt: "desc"}]
  const orderBy: Prisma.WorkflowTemplateOrderByWithRelationInput[] = []
  for (const {field, direction} of sort) {
    const value = direction === SortDirection.DESC ? "desc" : "asc"
    if (field === SortBy.CREATED_AT) orderBy.push({createdAt: value})
    else if (field === SortBy.UPDATED_AT) orderBy.push({updatedAt: value})
    else if (field === SortBy.VERSION) orderBy.push({version: value})
  }
  return orderBy.length === 0 ? [{createdAt: "desc"}] : orderBy
}

type WorkflowTemplateSummaryRecord = {
  readonly organizationId: string
  readonly id: string
  readonly name: string
  readonly version: number
  readonly description: string | null
  readonly status: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly defaultExpiresInHours?: number | null
}

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
    ...(template.defaultExpiresInHours === null || template.defaultExpiresInHours === undefined
      ? {}
      : {defaultExpiresInHours: template.defaultExpiresInHours})
  })
}

function mapTemplateSummaries(
  templates: ReadonlyArray<WorkflowTemplateSummaryRecord>
): E.Either<WorkflowTemplateValidationError, ListWorkflowTemplatesResponse["templates"]> {
  const summaries: WorkflowTemplateSummary[] = []
  for (const template of templates) {
    const summary = mapTemplateSummary(template)
    if (E.isLeft(summary)) return summary
    summaries.push(summary.right)
  }
  return E.right(summaries)
}

export function mapActionsToJsonb(actions: ReadonlyArray<WorkflowAction>): Prisma.InputJsonArray {
  return actions.map(action => {
    switch (action.type) {
      case WorkflowActionType.EMAIL:
        return {type: action.type, recipients: [...action.recipients]}
      case WorkflowActionType.WEBHOOK:
        return {
          type: action.type,
          url: action.url,
          method: action.method,
          ...(action.headers === undefined ? {} : {headers: {...action.headers}})
        }
      case WorkflowActionType.SLACK:
        return {type: action.type, webhookUrl: action.webhookUrl}
    }
  })
}

/** Cache only this snapshot's resolution, never a database read or write. Failed attempts may be retried. */
function deferWorkflowTemplate<Result>(
  task: TaskEither<EncryptionError | WorkflowTemplateValidationError, Result>
): DeferredWorkflowTemplate<Result> {
  let pending: ReturnType<typeof task> | undefined
  return {
    resolve: () => {
      if (pending === undefined)
        pending = task().then(
          result => {
            if (E.isLeft(result)) pending = undefined
            return result
          },
          error => {
            pending = undefined
            throw error
          }
        )
      return pending
    }
  }
}
