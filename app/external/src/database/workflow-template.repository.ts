import {
  WorkflowTemplate,
  WorkflowTemplateValidationError,
  ApprovalRule,
  ApprovalRuleType,
  WorkflowAction,
  WorkflowActionType,
  getMostRecentVersionFromTuples,
  WorkflowTemplateStatus
} from "@domain"
import {DatabaseClient} from "@external/database/database-client"
import {mapToDomainVersionedWorkflowTemplate, mapWorkflowTemplateToDomain} from "@external/database/shared"
import {chainNullableToLeft} from "@external/database/utils"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, WorkflowTemplate as PrismaWorkflowTemplate} from "@prisma/client"
import {
  CreateWorkflowTemplateRepoError,
  WorkflowTemplateGetError,
  WorkflowTemplateRepository,
  WorkflowTemplateUpdateError,
  ListWorkflowTemplatesRequestRepo,
  ListWorkflowTemplatesResponse,
  WorkflowTemplateGetActiveError,
  WorkflowTemplateGetParentSpaceError
} from "@services"
import {Versioned} from "@domain"
import {UnknownError} from "@services/error"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import * as O from "fp-ts/Option"
import {Option} from "fp-ts/Option"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import * as E from "fp-ts/Either"
import {Either} from "fp-ts/Either"
import {SortBy, SortDirection} from "@approvio/api"

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
  constructor(private readonly dbClient: DatabaseClient) {}

  /**
   * Creates a new workflow template in the database.
   * @param data The workflow template data to persist.
   * @returns A TaskEither with the created workflow template or an error.
   */
  createWorkflowTemplate(
    data: WorkflowTemplate
  ): TaskEither<CreateWorkflowTemplateRepoError | WorkflowTemplateValidationError, Versioned<WorkflowTemplate>> {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.persistWorkflowTemplate()),
      TE.chainEitherKW(mapToDomainVersionedWorkflowTemplate)
    )
  }

  getParentSpace(templateId: string): TaskEither<WorkflowTemplateGetParentSpaceError, string> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.cx.workflowTemplate.findUnique({
            where: {id: templateId},
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
   * @returns A TaskEither with the versioned workflow template or an error if not found.
   */
  getWorkflowTemplateById(templateId: string): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>> {
    const identifier: Identifier = {type: "id", id: templateId}
    return this.getWorkflowTemplate(identifier)
  }

  getWorkflowTemplateByNameAndVersion(
    templateName: string,
    version: number
  ): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>> {
    const identifier: Identifier = {type: "name_version", name: templateName, version: version}
    return this.getWorkflowTemplate(identifier)
  }

  getActiveWorkflowTemplateByName(
    templateName: string
  ): TaskEither<WorkflowTemplateGetActiveError, Versioned<WorkflowTemplate>> {
    return pipe(
      TE.tryCatch(
        async () => {
          const result = await this.dbClient.cx.workflowTemplate.findMany({
            where: {
              name: templateName,
              status: WorkflowTemplateStatus.ACTIVE
            }
          })

          if (result.length === 0) return null
          if (result.length > 1) throw new MultipleActiveWorkflowTemplatesError(templateName)

          return result[0]
        },
        error => {
          Logger.error(`Error while retrieving active workflow template by name ${templateName}. Unknown error`, error)
          return "unknown_error" as const
        }
      ),
      chainNullableToLeft("active_workflow_template_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedWorkflowTemplate)
    )
  }

  getMostRecentNonActiveWorkflowTemplateByName(
    templateName: string
  ): TaskEither<WorkflowTemplateGetError, Option<Versioned<WorkflowTemplate>>> {
    return pipe(
      TE.tryCatch(
        async () => {
          const templates = await this.dbClient.cx.workflowTemplate.findMany({
            where: {
              name: templateName,
              status: {not: WorkflowTemplateStatus.ACTIVE}
            },
            select: {
              id: true,
              version: true
            }
          })
          return templates
        },
        error => {
          Logger.error(
            `Error while retrieving non-active workflow templates by name ${templateName}. Unknown error`,
            error
          )
          return "unknown_error" as const
        }
      ),
      TE.chainW(templates => {
        if (templates.length === 0) return TE.right(O.none)

        const mostRecentResult = getMostRecentVersionFromTuples(templates)
        if (E.isLeft(mostRecentResult)) {
          Logger.error(`Error finding most recent version for template ${templateName}: ${mostRecentResult.left}`)
          return TE.left("unknown_error" as const)
        }

        return TE.right(O.some(mostRecentResult.right.id))
      }),
      TE.chainW(
        O.fold(
          () => TE.right(O.none),
          templateId => pipe(this.getWorkflowTemplateById(templateId), TE.map(O.some))
        )
      )
    )
  }

  updateWorkflowTemplate(
    template: Versioned<WorkflowTemplate>
  ): TaskEither<WorkflowTemplateUpdateError, Versioned<WorkflowTemplate>> {
    return pipe(
      template,
      TE.right,
      TE.chainW(template => this.updateWorkflowTemplateTask()({data: template, occCheck: template.occ})),
      TE.chainEitherKW(mapToDomainVersionedWorkflowTemplate)
    )
  }

  listWorkflowTemplates(
    request: ListWorkflowTemplatesRequestRepo
  ): TaskEither<WorkflowTemplateValidationError | UnknownError, ListWorkflowTemplatesResponse> {
    return pipe(
      TE.tryCatch(
        async () => {
          const skip = (request.pagination.page - 1) * request.pagination.limit

          const where: Prisma.WorkflowTemplateWhereInput = {}

          if (request.search) {
            if (request.searchMode === "EXACT") where.name = request.search
            else where.name = {contains: request.search, mode: "insensitive"}
          }

          if (request.filters?.spaceId) {
            where.spaceId = request.filters.spaceId
          } else if (request.filters?.spaceName) {
            where.spaces = {
              name: request.filters.spaceName
            }
          }

          if (request.filters?.status) where.status = {in: [...request.filters.status]}

          const orderBy: Prisma.WorkflowTemplateOrderByWithRelationInput[] = []
          const sortItems = request.sort ?? []

          if (sortItems.length > 0) {
            for (const {field, direction} of sortItems) {
              const dir = direction === SortDirection.DESC ? "desc" : "asc"

              if (field === SortBy.CREATED_AT) orderBy.push({createdAt: dir})
              else if (field === SortBy.UPDATED_AT) orderBy.push({updatedAt: dir})
              else if (field === SortBy.VERSION) orderBy.push({version: dir})
            }
          }

          if (orderBy.length === 0) orderBy.push({createdAt: "desc"})

          return Promise.all([
            this.dbClient.cx.workflowTemplate.findMany({
              skip,
              take: request.pagination.limit,
              orderBy,
              where
            }),
            this.dbClient.cx.workflowTemplate.count({where})
          ])
        },
        error => {
          Logger.error("Error while listing workflow templates. Unknown error", error)
          return "unknown_error" as const
        }
      ),
      TE.chainEitherKW(([templates, total]) =>
        pipe(
          templates,
          E.traverseArray(mapWorkflowTemplateToDomain),
          E.map(
            (domainTemplates): ListWorkflowTemplatesResponse => ({
              templates: domainTemplates.map(template => ({
                id: template.id,
                name: template.name,
                version: template.version,
                description: template.description,
                status: template.status,
                createdAt: template.createdAt,
                updatedAt: template.updatedAt
              })),
              pagination: {
                total,
                page: request.pagination.page,
                limit: request.pagination.limit
              }
            })
          )
        )
      )
    )
  }

  atomicUpdateAndCreate(data: {
    existingTemplate: Versioned<WorkflowTemplate>
    newTemplate: WorkflowTemplate
  }): TaskEither<WorkflowTemplateUpdateError, Versioned<WorkflowTemplate>> {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.atomicUpdateAndCreateTask()),
      TE.chainEitherKW(mapToDomainVersionedWorkflowTemplate)
    )
  }

  getWorkflowTemplatesParentsByNames(
    templateNames: ReadonlyArray<string>
  ): TaskEither<"workflow_template_not_found", ReadonlyMap<string, string>> {
    if (templateNames.length === 0) return TE.right(new Map())

    return pipe(
      TE.tryCatch(
        async () =>
          this.dbClient.cx.workflowTemplate.findMany({
            where: {name: {in: [...templateNames]}},
            distinct: ["name"],
            select: {name: true, spaceId: true}
          }),
        error => {
          Logger.error("Error while retrieving workflow template space mappings. Unknown error", error)
          return "workflow_template_not_found" as const
        }
      ),
      TE.chainW(templates => {
        if (templates.length !== templateNames.length) return TE.left("workflow_template_not_found" as const)

        const mappings = templates.map(t => {
          return TE.right([t.name, t.spaceId] as const)
        })

        return pipe(
          mappings,
          TE.sequenceArray,
          TE.map(entries => new Map(entries))
        )
      })
    )
  }

  countUniqueWorkflowTemplatesBySpaceId(spaceId: string): TaskEither<UnknownError, number> {
    return TE.tryCatch(
      async () => {
        const result = await this.dbClient.cx.$queryRaw<{count: bigint}[]>(
          Prisma.sql`SELECT COUNT(DISTINCT name) as count FROM workflow_templates WHERE space_id = ${spaceId}::uuid`
        )
        return Number(result[0]?.count ?? 0)
      },
      error => {
        Logger.error(`Error counting workflow templates in space ${spaceId}`, error)
        return "unknown_error"
      }
    )
  }

  private atomicUpdateAndCreateTask(): (data: {
    existingTemplate: Versioned<WorkflowTemplate>
    newTemplate: WorkflowTemplate
  }) => TaskEither<WorkflowTemplateUpdateError | CreateWorkflowTemplateRepoError, PrismaWorkflowTemplate> {
    return data =>
      pipe(
        TE.tryCatchK(
          () => this.atomicUpdateAndCreateTaskNoErrorHandling(data),
          error => {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
              return "concurrency_error" as const
            }
            Logger.error(`Error while deprecating old template and creating new one: ${error}`, error)
            return "unknown_error" as const
          }
        )(),
        TE.chainEitherKW(result => result)
      )
  }

  private atomicUpdateAndCreateTaskNoErrorHandling(data: {
    existingTemplate: Versioned<WorkflowTemplate>
    newTemplate: WorkflowTemplate
  }): Promise<Either<WorkflowTemplateUpdateError | CreateWorkflowTemplateRepoError, PrismaWorkflowTemplate>> {
    const {existingTemplate, newTemplate} = data

    return this.dbClient.transactional(async () => {
      return pipe(
        TE.Do,
        TE.bindW("updatedTemplate", () =>
          this.updateWorkflowTemplateTask()({data: existingTemplate, occCheck: existingTemplate.occ})
        ),
        TE.bindW("createdTemplate", () => this.persistWorkflowTemplate()(newTemplate)),
        TE.map(({createdTemplate}) => createdTemplate)
      )()
    })
  }

  private updateWorkflowTemplateTask(): (request: {
    data: WorkflowTemplate
    occCheck: bigint
  }) => TaskEither<WorkflowTemplateUpdateError, PrismaWorkflowTemplate> {
    return ({data, occCheck}) =>
      TE.tryCatchK(
        () => {
          const prismaData = mapWorkflowTemplateToPrisma(data)
          const whereClause: Prisma.WorkflowTemplateWhereUniqueInput = {id: data.id, occ: occCheck}

          return this.dbClient.cx.workflowTemplate.update({
            where: whereClause,
            data: {
              ...prismaData,
              occ: {increment: 1}
            }
          })
        },
        error => {
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.WorkflowTemplate)) return "concurrency_error" as const
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
            return "concurrency_error" as const
          Logger.error(`Error while updating workflow template ${data.id}. Unknown error`, error)
          return "unknown_error"
        }
      )()
  }

  private getWorkflowTemplate(
    identifier: Identifier
  ): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>> {
    return pipe(
      identifier,
      TE.right,
      TE.chainW(this.getObjectTask()),
      chainNullableToLeft("workflow_template_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedWorkflowTemplate)
    )
  }

  private getObjectTask(): (
    identifier: Identifier
  ) => TaskEither<WorkflowTemplateGetError, PrismaWorkflowTemplate | null> {
    return identifier =>
      TE.tryCatchK(
        () => {
          const where: Prisma.WorkflowTemplateWhereUniqueInput =
            identifier.type === "id"
              ? {
                  id: identifier.id
                }
              : {name_version: {name: identifier.name, version: identifier.version}}

          return this.dbClient.cx.workflowTemplate.findUnique({where})
        },
        error => {
          Logger.error(`Error while retrieving workflow template by ${identifier.type}. Unknown error`, error)
          return "unknown_error" as const
        }
      )()
  }

  private persistWorkflowTemplate(): (
    data: WorkflowTemplate
  ) => TaskEither<CreateWorkflowTemplateRepoError, PrismaWorkflowTemplate> {
    return data =>
      TE.tryCatchK(
        () =>
          this.dbClient.cx.workflowTemplate.create({
            data: {
              id: data.id,
              name: data.name,
              version: data.version,
              description: data.description,
              approvalRule: mapApprovalRuleToJsonb(data.approvalRule),
              actions: data.actions,
              defaultExpiresInHours: data.defaultExpiresInHours,
              status: data.status,
              allowVotingOnDeprecatedTemplate: data.allowVotingOnDeprecatedTemplate,
              spaceId: data.spaceId,
              createdAt: data.createdAt,
              updatedAt: data.updatedAt,
              occ: POSTGRES_BIGINT_LOWER_BOUND
            }
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["name", "version"])) return "workflow_template_already_exists"
          Logger.error(`Error creating workflow template: ${error}`, error)
          return "unknown_error"
        }
      )()
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

function mapActionsToJsonb(actions: WorkflowAction[]): Prisma.InputJsonArray {
  return actions.map(action => mapActionToJsonb(action))
}

function mapActionToJsonb(action: WorkflowAction): Prisma.InputJsonValue {
  switch (action.type) {
    case WorkflowActionType.EMAIL:
      return {
        type: action.type,
        recipients: [...action.recipients]
      }
    case WorkflowActionType.WEBHOOK:
      return {
        type: action.type,
        url: action.url,
        method: action.method,
        headers: action.headers ? {...action.headers} : undefined
      }
  }
}

function mapWorkflowTemplateToPrisma(data: WorkflowTemplate): Omit<Prisma.WorkflowTemplateUpdateInput, "occ"> {
  return {
    id: data.id,
    name: data.name,
    version: data.version,
    description: data.description ?? null,
    approvalRule: mapApprovalRuleToJsonb(data.approvalRule),
    actions: mapActionsToJsonb([...data.actions]),
    defaultExpiresInHours: data.defaultExpiresInHours ?? null,
    status: data.status,
    allowVotingOnDeprecatedTemplate: data.allowVotingOnDeprecatedTemplate,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  }
}

class MultipleActiveWorkflowTemplatesError extends Error {
  constructor(templateName: string) {
    super(`Multiple active workflow templates found for name ${templateName}`)
    this.name = "MultipleActiveWorkflowTemplatesError"
  }
}
