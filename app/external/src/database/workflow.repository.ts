import {Workflow, WorkflowFactory, WorkflowValidationError} from "@domain"
import {Injectable, Logger} from "@nestjs/common"
import {CreateWorkflowRepo, CreateWorkflowRepoError, WorkflowRepository} from "@services"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {DatabaseClient} from "./database-client"
import {Either} from "fp-ts/Either"
import * as E from "fp-ts/Either"
import {Prisma, Workflow as PrismaWorkflow} from "@prisma/client"
import {isPrismaUniqueConstraintError} from "./errors"

@Injectable()
export class WorkflowDbRepository implements WorkflowRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  createWorkflow(data: CreateWorkflowRepo): TaskEither<CreateWorkflowRepoError | WorkflowValidationError, Workflow> {
    return pipe(data, TE.right, TE.chainW(this.persistWorkflow()), TE.chainEitherKW(mapToDomainWorkflow))
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
              occ: POSTGRES_BIGINT_LOWER_BOUND
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

export function mapToDomainWorkflow(dbObject: PrismaWorkflow): Either<WorkflowValidationError, Workflow> {
  const eitherRule = prismaJsonToJson(dbObject.rule)

  if (E.isLeft(eitherRule)) return eitherRule

  const object = {
    createdAt: dbObject.createdAt,
    description: dbObject.description ?? undefined,
    id: dbObject.id,
    name: dbObject.name,
    updatedAt: dbObject.updatedAt,
    rule: eitherRule.right,
    status: dbObject.status,
    occ: dbObject.occ
  }

  return pipe(object, WorkflowFactory.validate)
}

function prismaJsonToJson(prismaJson: Prisma.JsonValue): Either<"rule_invalid", JSON> {
  if (prismaJson === null) return E.left("rule_invalid")
  return E.right(JSON.parse(JSON.stringify(prismaJson)))
}
