import {Injectable, Logger} from "@nestjs/common"
import {StepUpReceiptFactory, StepUpReceipt, StepUpReceiptState, TenantContext, ConsumedStepUpReceipt} from "@domain"
import * as E from "fp-ts/Either"
import {RepositoryDependencyError, StepUpReceiptRepository} from "@services"
import * as TE from "fp-ts/TaskEither"
import {v7 as uuidv7} from "uuid"
import {StepUpReceiptTenantClient} from "./tenant-database-clients"
import {Prisma} from "@prisma/client"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"

type ReceiptError = "invalid_credential" | "organization_context_changed" | RepositoryDependencyError

@Injectable()
export class StepUpReceiptDbRepository implements StepUpReceiptRepository {
  constructor(private readonly dbClient: StepUpReceiptTenantClient) {}

  issue(context: TenantContext, receipt: StepUpReceipt): TE.TaskEither<ReceiptError, void> {
    return TE.tryCatch(
      async () => {
        if (context.organizationId !== receipt.organizationId) throw new InvalidReceiptError()
        await this.dbClient.cx.stepUpReceipt.create({
          data: {...receipt, id: uuidv7(), consumedAt: null, createdAt: new Date()}
        })
      },
      error => this.mapError(error, "issue")
    )
  }

  get(context: TenantContext, jti: string): TE.TaskEither<ReceiptError, StepUpReceiptState> {
    return TE.tryCatch(
      async () => {
        const receipt = await this.dbClient.cx.stepUpReceipt.findUnique({
          where: {organizationId_jti: {organizationId: context.organizationId, jti}},
          select: {
            organizationId: true,
            jti: true,
            userId: true,
            sessionId: true,
            providerId: true,
            contextVersion: true,
            operation: true,
            resourceId: true,
            expiresAt: true,
            consumedAt: true
          }
        })
        if (!receipt) throw new InvalidReceiptError()
        const {consumedAt, ...issued} = receipt
        const state = StepUpReceiptFactory.validate({
          ...issued,
          status: consumedAt === null ? "unconsumed" : "consumed",
          ...(consumedAt === null ? {} : {consumedAt})
        })
        if (E.isLeft(state)) throw new InvalidReceiptError()
        return state.right
      },
      error => this.mapError(error, "get")
    )
  }

  persist(context: TenantContext, receipt: ConsumedStepUpReceipt): TE.TaskEither<ReceiptError, void> {
    return TE.tryCatch(
      async () => {
        if (context.organizationId !== receipt.organizationId) throw new InvalidReceiptError()
        await this.dbClient.cx.stepUpReceipt.update({
          where: {
            organizationId_jti: {organizationId: context.organizationId, jti: receipt.jti},
            userId: receipt.userId,
            sessionId: receipt.sessionId,
            providerId: receipt.providerId,
            contextVersion: receipt.contextVersion,
            operation: receipt.operation,
            resourceId: receipt.resourceId,
            // Persist only if the stored receipt still matches the state used by the domain transition.
            expiresAt: receipt.expiresAt,
            consumedAt: null
          },
          data: {consumedAt: receipt.consumedAt}
        })
      },
      error => this.mapError(error, "persist")
    )
  }

  private mapError(error: unknown, operation: string): ReceiptError {
    if (isPrismaRecordNotFoundError(error, Prisma.ModelName.StepUpReceipt)) return "invalid_credential"
    if (error instanceof InvalidReceiptError) return "invalid_credential"
    if (isPrismaUniqueConstraintError(error, ["organization_id", "jti"])) return "organization_context_changed"
    Logger.error(`Step-up receipt repository ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "repository_dependency_error"
  }
}

class InvalidReceiptError extends Error {}
