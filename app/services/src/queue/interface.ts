import {UnknownError} from "@services/error"
import {BoundaryError, TenantEvent} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"

export type EnqueueTenantEventError = BoundaryError | UnknownError
export type QueueHealthCheckFailed = "queue_health_check_failed"

export const QUEUE_PROVIDER_TOKEN = Symbol("QUEUE_PROVIDER_TOKEN")

export interface QueueProvider {
  // TODO: We lost the ability to perform a buld insertion. Do we need this ?
  enqueue(event: TenantEvent): TaskEither<EnqueueTenantEventError, void>
  /**
   * Checks the health of the queue provider.
   * @returns A TaskEither with void (healthy) or an UnknownError (unhealthy).
   */
  checkHealth(): TaskEither<QueueHealthCheckFailed, void>
}
