import {fromPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {
  StepUpReceiptFactory,
  StepUpReceipt,
  TenantContext,
  ConsumedStepUpReceipt,
  StepUpReceiptValidationError
} from "@domain"
import {RepositoryDependencyError, StepUpReceiptRepository} from "@services"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {chainNullableToLeft} from "./utils"
import {StepUpReceiptTenantClient} from "./tenant-database-clients"
import {Prisma} from "@prisma/client"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"

@Injectable()
export class StepUpReceiptDbRepository implements StepUpReceiptRepository {
  constructor(private readonly dbClient: StepUpReceiptTenantClient) {}

  issue(receipt: StepUpReceipt): TE.TaskEither<"resource_already_exists" | RepositoryDependencyError, void> {
    return fromPromise(
      async () => {
        await this.dbClient.cx.stepUpReceipt.create({
          data: receipt
        })
      },
      error =>
        isPrismaUniqueConstraintError(error, ["organization_id", "jti"])
          ? ("resource_already_exists" as const)
          : this.mapError(error, "issue")
    )
  }

  get(
    context: TenantContext,
    jti: string
  ): TE.TaskEither<StepUpReceiptValidationError | "resource_not_found" | RepositoryDependencyError, StepUpReceipt> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.stepUpReceipt.findUnique({
            where: {organizationId_jti: {organizationId: context.organizationId, jti}}
          }),
        error => this.mapError(error, "get")
      ),
      chainNullableToLeft("resource_not_found" as const),
      TE.chainEitherKW(receipt => StepUpReceiptFactory.validate(receipt))
    )
  }

  markConsumed(
    context: TenantContext,
    receipt: ConsumedStepUpReceipt
  ): TE.TaskEither<"concurrent_modification_error" | RepositoryDependencyError, void> {
    return fromPromise(
      async () => {
        await this.dbClient.cx.stepUpReceipt.update({
          where: {
            organizationId_jti: {organizationId: context.organizationId, jti: receipt.jti},
            // Receipt fields are immutable; this atomic check lets only one consumer succeed.
            consumedAt: null
          },
          data: {consumedAt: receipt.consumedAt}
        })
      },
      error =>
        isPrismaRecordNotFoundError(error, Prisma.ModelName.StepUpReceipt)
          ? ("concurrent_modification_error" as const)
          : this.mapError(error, "markConsumed")
    )
  }

  private mapError(error: unknown, operation: string): RepositoryDependencyError {
    Logger.error(`Step-up receipt repository ${operation} failed`, error)
    return "repository_dependency_error"
  }
}
