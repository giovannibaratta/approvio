import {WorkflowTemplate, WorkflowTemplateValidationError, WorkflowTemplateSummary} from "@domain"
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
  WorkflowTemplateDeleteError,
  WorkflowTemplateUpdateDataRepo,
  ListWorkflowTemplatesRequest,
  ListWorkflowTemplatesResponse
} from "@services"
import {Versioned} from "@services/shared/utils"
import {UnknownError} from "@services/error"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {isPrismaUniqueConstraintError} from "./errors"

interface Identifier {
  identifier: string
  type: "id" | "name"
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
    const identifier: Identifier = {type: "id", identifier: templateId}
    return this.getWorkflowTemplate(identifier)
  }

  /**
   * Gets a workflow template by its unique name.
   * @param name The name of the workflow template.
   * @returns A TaskEither with the versioned workflow template or an error if not found.
   */
  getWorkflowTemplateByName(name: string): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>> {
    const identifier: Identifier = {type: "name", identifier: name}
    return this.getWorkflowTemplate(identifier)
  }

  updateWorkflowTemplate(
    templateId: string,
    data: WorkflowTemplateUpdateDataRepo,
    occCheck?: bigint
  ): TaskEither<WorkflowTemplateUpdateError, Versioned<WorkflowTemplate>> {
    return pipe(
      {templateId, data, occCheck},
      TE.right,
      TE.chainW(this.updateWorkflowTemplateTask()),
      TE.chainEitherKW(mapToDomainVersionedWorkflowTemplate)
    )
  }

  deleteWorkflowTemplate(templateId: string): TaskEither<WorkflowTemplateDeleteError, void> {
    return TE.tryCatchK(
      async () => {
        await this.dbClient.workflowTemplate.delete({
          where: {id: templateId}
        })
      },
      error => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
          return "workflow_template_not_found"
        }
        Logger.error(`Error while deleting workflow template ${templateId}. Unknown error`, error)
        return "unknown_error"
      }
    )()
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

  private updateWorkflowTemplateTask(): (data: {
    templateId: string
    data: Omit<Prisma.WorkflowTemplateUpdateInput, "id" | "occ">
    occCheck?: bigint
  }) => TaskEither<WorkflowTemplateUpdateError, PrismaWorkflowTemplate> {
    return ({templateId, data, occCheck}) =>
      TE.tryCatchK(
        () => {
          const whereClause = occCheck !== undefined ? {id: templateId, occ: occCheck} : {id: templateId}

          return this.dbClient.workflowTemplate.update({
            where: whereClause,
            data
          })
        },
        error => {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
            return occCheck !== undefined ? "concurrency_error" : "workflow_template_not_found"
          }
          Logger.error(`Error while updating workflow template ${templateId}. Unknown error`, error)
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
        () =>
          this.dbClient.workflowTemplate.findUnique({
            where: {
              id: identifier.type === "id" ? identifier.identifier : undefined,
              name: identifier.type === "name" ? identifier.identifier : undefined
            }
          }),
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
          this.dbClient.workflowTemplate.create({
            data: {
              id: data.id,
              name: data.name,
              description: data.description,
              approvalRule: data.approvalRule,
              actions: data.actions,
              defaultExpiresInHours: data.defaultExpiresInHours,
              createdAt: data.createdAt,
              updatedAt: data.updatedAt,
              occ: POSTGRES_BIGINT_LOWER_BOUND
            }
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["name"])) return "workflow_template_already_exists"
          Logger.error(`Error creating workflow template: ${error}`, error)
          return "unknown_error"
        }
      )()
  }
}
