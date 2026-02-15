import {
  WorkflowTemplate,
  WorkflowTemplateValidationError,
  WorkflowTemplateSummary,
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
  ListWorkflowTemplatesRequest,
  ListWorkflowTemplatesResponse
} from "@services"
import {Versioned} from "@domain"
import {UnknownError} from "@services/error"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import * as O from "fp-ts/Option"
import {Option} from "fp-ts/Option"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {isPrismaUniqueConstraintError} from "./errors"
import {Either} from "fp-ts/lib/Either"

type Identifier = IdIdentifier | NameVersionIdentifier

interface IdIdentifier {
  id: string
  type: "id"
}

interface NameVersionIdentifier {
  type: "name_version"
  name: string
  version: string
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
  ): TaskEither<CreateWorkflowTemplateRepoError | WorkflowTemplateValidationError, WorkflowTemplate> {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.persistWorkflowTemplate()),
      TE.chainEitherKW(mapWorkflowTemplateToDomain)
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
    version: string
  ): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>> {
    const identifier: Identifier = {type: "name_version", name: templateName, version: version.toString()}
    return this.getWorkflowTemplate(identifier)
  }

  getMostRecentNonActiveWorkflowTemplateByName(
    templateName: string
  ): TaskEither<WorkflowTemplateGetError, Option<Versioned<WorkflowTemplate>>> {
    return pipe(
      TE.tryCatch(
        async () => {
          const templates = await this.dbClient.workflowTemplate.findMany({
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
        if (templates.length === 0) {
          return TE.right(O.none)
        }

        const mostRecentResult = getMostRecentVersionFromTuples(templates)
        if (mostRecentResult._tag === "Left") {
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
    request: ListWorkflowTemplatesRequest
  ): TaskEither<WorkflowTemplateValidationError | UnknownError, ListWorkflowTemplatesResponse> {
    return TE.tryCatchK(
      async () => {
        const skip = (request.pagination.page - 1) * request.pagination.limit
        const [templates, total] = await Promise.all([
          this.dbClient.workflowTemplate.findMany({
            skip,
            take: request.pagination.limit,
            orderBy: {createdAt: "desc"}
          }),
          this.dbClient.workflowTemplate.count()
        ])

        const domainTemplates = templates
          .map(template => mapWorkflowTemplateToDomain(template))
          .filter(result => result._tag === "Right")
          .map(result => result.right)

        const workflowTemplateSummaries: ReadonlyArray<WorkflowTemplateSummary> = domainTemplates.map(template => ({
          id: template.id,
          name: template.name,
          version: template.version,
          description: template.description,
          createdAt: template.createdAt,
          updatedAt: template.updatedAt
        }))

        return {
          templates: workflowTemplateSummaries,
          pagination: {
            total,
            page: request.pagination.page,
            limit: request.pagination.limit
          }
        }
      },
      error => {
        Logger.error("Error while listing workflow templates. Unknown error", error)
        return "unknown_error" as const
      }
    )()
  }

  atomicUpdateAndCreate(data: {
    existingTemplate: Versioned<WorkflowTemplate>
    newTemplate: WorkflowTemplate
  }): TaskEither<WorkflowTemplateUpdateError, WorkflowTemplate> {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.atomicUpdateAndCreateTask()),
      TE.chainEitherKW(mapWorkflowTemplateToDomain)
    )
  }

  getWorkflowTemplatesParents(
    templateIds: ReadonlyArray<string>
  ): TaskEither<"workflow_template_not_found", ReadonlyMap<string, string>> {
    if (templateIds.length === 0) return TE.right(new Map())

    return pipe(
      TE.tryCatch(
        async () =>
          this.dbClient.workflowTemplate.findMany({
            where: {id: {in: [...templateIds]}},
            select: {id: true, spaceId: true}
          }),
        error => {
          Logger.error("Error while retrieving workflow template space mappings. Unknown error", error)
          return "workflow_template_not_found" as const
        }
      ),
      TE.chainW(templates => {
        if (templates.length !== templateIds.length) return TE.left("workflow_template_not_found" as const)

        const mappings = templates.map(t => {
          return TE.right([t.id, t.spaceId] as const)
        })

        return pipe(
          mappings,
          TE.sequenceArray,
          TE.map(entries => new Map(entries))
        )
      })
    )
  }

  countWorkflowTemplatesBySpaceId(spaceId: string): TaskEither<UnknownError, number> {
    return TE.tryCatch(
      () => this.dbClient.workflowTemplate.count({where: {spaceId}}),
      error => {
        Logger.error("Error counting workflow templates", error)
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

    return this.dbClient.$transaction(async tx => {
      return pipe(
        TE.Do,
        TE.bindW("updatedTemplate", () =>
          this.updateWorkflowTemplateTask(tx)({data: existingTemplate, occCheck: existingTemplate.occ})
        ),
        TE.bindW("createdTemplate", () => this.persistWorkflowTemplate(tx)(newTemplate)),
        TE.map(({createdTemplate}) => createdTemplate)
      )()
    })
  }

  private updateWorkflowTemplateTask(
    optionalClient?: Prisma.TransactionClient
  ): (request: {
    data: WorkflowTemplate
    occCheck?: bigint
  }) => TaskEither<WorkflowTemplateUpdateError, PrismaWorkflowTemplate> {
    const client = optionalClient ?? this.dbClient

    return ({data, occCheck}) =>
      TE.tryCatchK(
        () => {
          const prismaData = mapWorkflowTemplateToPrisma(data)
          const whereClause: Prisma.WorkflowTemplateWhereUniqueInput =
            occCheck !== undefined ? {id: data.id, occ: occCheck} : {id: data.id}

          return client.workflowTemplate.update({
            where: whereClause,
            data: {
              ...prismaData,
              occ: {increment: 1}
            }
          })
        },
        error => {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
            return occCheck !== undefined ? "concurrency_error" : "workflow_template_not_found"
          }
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            return "concurrency_error" as const
          }
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

          return this.dbClient.workflowTemplate.findUnique({where})
        },
        error => {
          Logger.error(`Error while retrieving workflow template by ${identifier.type}. Unknown error`, error)
          return "unknown_error" as const
        }
      )()
  }

  private persistWorkflowTemplate(
    optionalClient?: Prisma.TransactionClient
  ): (data: WorkflowTemplate) => TaskEither<CreateWorkflowTemplateRepoError, PrismaWorkflowTemplate> {
    const client = optionalClient ?? this.dbClient
    return data =>
      TE.tryCatchK(
        () =>
          client.workflowTemplate.create({
            data: {
              id: data.id,
              name: data.name,
              version: data.version.toString(),
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
        minCount: approvalRule.minCount
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
    version: data.version.toString(),
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
