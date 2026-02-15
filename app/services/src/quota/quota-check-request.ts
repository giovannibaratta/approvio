import {QuotaMetric} from "@domain"

export type QuotaCheckRequest =
  | {metric: "MAX_GROUPS"; targetId: null}
  | {metric: "MAX_SPACES"; targetId: null}
  | {metric: "MAX_TEMPLATES"; targetId: string}
  | {metric: "MAX_USERS"; targetId: string}
  | {metric: "MAX_CONCURRENT_WORKFLOWS"; targetId: string}
  | {metric: "MAX_ROLES"; targetId: string}

export const QuotaCheckRequestFactory = {
  create: (metric: QuotaMetric, targetId?: string): QuotaCheckRequest => {
    switch (metric) {
      case "MAX_GROUPS":
        return {metric: "MAX_GROUPS", targetId: null}
      case "MAX_SPACES":
        return {metric: "MAX_SPACES", targetId: null}
      case "MAX_TEMPLATES":
        if (!targetId) throw new Error("Target ID is required for MAX_TEMPLATES")
        return {metric: "MAX_TEMPLATES", targetId}
      case "MAX_USERS":
        if (!targetId) throw new Error("Target ID is required for MAX_USERS")
        return {metric: "MAX_USERS", targetId}
      case "MAX_CONCURRENT_WORKFLOWS":
        if (!targetId) throw new Error("Target ID is required for MAX_CONCURRENT_WORKFLOWS")
        return {metric: "MAX_CONCURRENT_WORKFLOWS", targetId}
      case "MAX_ROLES":
        if (!targetId) throw new Error("Target ID is required for MAX_ROLES")
        return {metric: "MAX_ROLES", targetId}
    }
  }
}
