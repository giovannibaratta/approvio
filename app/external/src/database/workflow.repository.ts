import {Workflow, WorkflowValidationError} from "@domain"
import {DatabaseClient} from "@external/database/database-client"
import {mapToDomainVersionedWorkflow, mapWorkflowToDomain} from "@external/database/shared"
import {chainNullableToLeft} from "@external/database/utils"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, Workflow as PrismaWorkflow} from "@prisma/client"
import {
  ConcurrentSafeWorkflowUpdateData,
  ConcurrentUnsafeWorkflowUpdateData,
  CreateWorkflowRepo,
  CreateWorkflowRepoError,
  WorkflowGetError,
  WorkflowRepository,
  WorkflowUpdateError
} from "@services"
import {Versioned} from "@services/shared/utils"
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
export class WorkflowDbRepository implements WorkflowRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  /**
   * Creates a new workflow in the database.
   * @param data The workflow data to persist.
   * @returns A TaskEither with the created workflow or an error.
   */
  createWorkflow(data: CreateWorkflowRepo): TaskEither<CreateWorkflowRepoError | WorkflowValidationError, Workflow> {
    return pipe(data, TE.right, TE.chainW(this.persistWorkflow()), TE.chainEitherKW(mapWorkflowToDomain))
  }

  /**
   * Gets a workflow by its UUID.
   * @param workflowId The ID of the workflow.
   * @returns A TaskEither with the versioned workflow or an error if not found.
   */
  getWorkflowById(workflowId: string): TaskEither<WorkflowGetError, Versioned<Workflow>> {
    const identifier: Identifier = {type: "id", identifier: workflowId}
    return this.getWorkflow(identifier)
  }

  /**
   * Gets a workflow by its unique name.
   * @param name The name of the workflow.
   * @returns A TaskEither with the versioned workflow or an error if not found.
   */
  getWorkflowByName(name: string): TaskEither<WorkflowGetError, Versioned<Workflow>> {
    const identifier: Identifier = {type: "name", identifier: name}
    return this.getWorkflow(identifier)
  }

  updateWorkflow(
    workflowId: string,
    data: ConcurrentSafeWorkflowUpdateData
  ): TaskEither<WorkflowUpdateError, Versioned<Workflow>> {
    return pipe(
      {workflowId, data},
      TE.right,
      TE.chainW(this.updateWorkflowTask()),
      TE.chainEitherKW(mapToDomainVersionedWorkflow)
    )
  }

  updateWorkflowConcurrentSafe(
    workflowId: string,
    occCheck: bigint,
    data: ConcurrentUnsafeWorkflowUpdateData
  ): TaskEither<WorkflowUpdateError, Versioned<Workflow>> {
    return pipe(
      {workflowId, data, occCheck},
      TE.right,
      TE.chainW(this.updateWorkflowTask()),
      TE.chainEitherKW(mapToDomainVersionedWorkflow)
    )
  }

  private updateWorkflowTask(): (data: {
    workflowId: string
    data: Omit<Prisma.WorkflowUpdateInput, "id" | "occ">
    occCheck?: bigint
  }) => TaskEither<WorkflowUpdateError, PrismaWorkflow> {
    return ({workflowId, data, occCheck}) =>
      TE.tryCatchK(
        () =>
          this.dbClient.workflow.update({
            where: {id: workflowId, occ: occCheck},
            data
          }),
        error => {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
            return "concurrency_error" as const
          }
          Logger.error(`Error while updating workflow ${workflowId}. Unknown error`, error)
          return "unknown_error" as const
        }
      )()
  }

  private getWorkflow(identifier: Identifier): TaskEither<WorkflowGetError, Versioned<Workflow>> {
    return pipe(
      identifier,
      TE.right,
      TE.chainW(this.getObjectTask()),
      chainNullableToLeft("workflow_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedWorkflow)
    )
  }

  private getObjectTask(): (identifier: Identifier) => TaskEither<WorkflowGetError, PrismaWorkflow | null> {
    return identifier =>
      TE.tryCatchK(
        () =>
          this.dbClient.workflow.findUnique({
            where: {
              id: identifier.type === "id" ? identifier.identifier : undefined,
              name: identifier.type === "name" ? identifier.identifier : undefined
            }
          }),
        error => {
          Logger.error(`Error while retrieving workflow by ${identifier.type}. Unknown error`, error)
          return "unknown_error" as const
        }
      )()
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
              rule: data.workflow.rule,
              status: data.workflow.status,
              createdAt: data.workflow.createdAt,
              updatedAt: data.workflow.updatedAt,
              occ: POSTGRES_BIGINT_LOWER_BOUND,
              recalculationRequired: data.workflow.recalculationRequired
            }
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["name"])) return "workflow_already_exists"
          Logger.error(`Error creating workflow: ${error}`, error)
          return "unknown_error" as const
        }
      )()
  }
}
