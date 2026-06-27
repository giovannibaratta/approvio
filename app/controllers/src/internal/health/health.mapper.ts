import {HealthResponse} from "@approvio/api"
import {DbHealthCheckFailed} from "@services/health"
import {QueueHealthCheckFailed} from "@services/queue"

export const mapToGetHealthResponse = (
  result: DbHealthCheckFailed | QueueHealthCheckFailed | "success"
): HealthResponse => {
  if (result === "success")
    return {
      status: "OK"
    }

  return {
    status: "DEPENDENCY_ERROR",
    message: result.toUpperCase()
  }
}
