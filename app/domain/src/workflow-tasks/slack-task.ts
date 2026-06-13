import {PrefixUnion, getStringAsEnum, hasOwnProperty, isValidUrl, DecorableEntity} from "@utils"
import {Either, isLeft, left, right} from "fp-ts/Either"
import {
  TaskStatus,
  WorkflowActionCompletedTaskData,
  WorkflowActionErrorTaskData,
  WorkflowActionPendingTaskData,
  WorkflowActionTaskData,
  WorkflowActionTaskDecoratorSelector,
  WorkflowActionTaskDecorators,
  WorkflowActionTaskFactory,
  WorkflowActionTaskValidationError
} from "./base"
import {HttpResponse, ResponseBodyStatus} from "../http"

export type DecoratedWorkflowActionSlackTask<T extends WorkflowActionTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionSlackTaskData,
  WorkflowActionTaskDecorators,
  T
>

export type DecoratedWorkflowActionSlackPendingTask<T extends WorkflowActionTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionSlackPendingTaskData,
  WorkflowActionTaskDecorators,
  T
>

export type DecoratedWorkflowActionSlackCompletedTask<T extends WorkflowActionTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionSlackCompletedTaskData,
  WorkflowActionTaskDecorators,
  T
>

export type DecoratedWorkflowActionSlackErrorTask<T extends WorkflowActionTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionSlackErrorTaskData,
  WorkflowActionTaskDecorators,
  T
>

export type WorkflowActionSlackTaskData =
  | WorkflowActionSlackPendingTaskData
  | WorkflowActionSlackCompletedTaskData
  | WorkflowActionSlackErrorTaskData

export type WorkflowActionSlackBaseTaskData = WorkflowActionTaskData & {
  webhookUrl: string
  message?: string
}

export type WorkflowActionSlackPendingTaskData = WorkflowActionSlackBaseTaskData & WorkflowActionPendingTaskData

export type WorkflowActionSlackCompletedTaskData = WorkflowActionSlackBaseTaskData &
  WorkflowActionCompletedTaskData & {response: HttpResponse}

export type WorkflowActionSlackErrorTaskData = WorkflowActionSlackBaseTaskData &
  WorkflowActionErrorTaskData & {
    response?: HttpResponse
  }

export type WorkflowActionSlackTaskValidationError =
  | WorkflowActionTaskValidationError
  | PrefixUnion<"workflow_action_slack_task", UnprefixedWorkflowActionSlackTaskValidationError>

type UnprefixedWorkflowActionSlackTaskValidationError =
  | "completed_with_response_missing"
  | "response_invalid"
  | "webhook_url_invalid"
  | "webhook_url_missing_or_invalid"

export class WorkflowActionSlackTaskFactory {
  static newWorkflowActionSlackTask(
    data: Omit<WorkflowActionSlackPendingTaskData, "status" | "retryCount" | "createdAt" | "updatedAt" | "errorReason">
  ): Either<WorkflowActionSlackTaskValidationError, DecoratedWorkflowActionSlackPendingTask<{occ: true}>> {
    const now = new Date()

    const entity: DecoratedWorkflowActionSlackPendingTask<{occ: true}> = {
      ...data,
      status: TaskStatus.PENDING,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      occ: 0n
    }

    const validated = WorkflowActionSlackTaskFactory.validate<{occ: true}>(entity)

    if (isLeft(validated)) return validated

    return right(entity)
  }

  static toFailedSlack<T extends WorkflowActionTaskDecoratorSelector>(
    task: DecoratedWorkflowActionSlackTask<T>,
    newData: {
      response: HttpResponse | null
      errorReason: string
    }
  ): Either<WorkflowActionSlackTaskValidationError, DecoratedWorkflowActionSlackTask<T>> {
    const newObj = {
      ...task,
      updatedAt: new Date(),
      retryCount: task.retryCount + 1,
      errorReason: newData.errorReason,
      response: newData.response ? newData.response : undefined,
      status: TaskStatus.ERROR
    }

    return WorkflowActionSlackTaskFactory.validate(newObj)
  }

  static toCompletedSlack<T extends WorkflowActionTaskDecoratorSelector>(
    task: DecoratedWorkflowActionSlackTask<T>,
    newData: {
      response: HttpResponse
    }
  ): Either<WorkflowActionSlackTaskValidationError, DecoratedWorkflowActionSlackTask<T>> {
    const newObj = {
      ...task,
      updatedAt: new Date(),
      retryCount: task.retryCount,
      response: newData.response,
      errorReason: undefined,
      status: TaskStatus.COMPLETED
    }

    return WorkflowActionSlackTaskFactory.validate(newObj)
  }

  static validate<T extends WorkflowActionTaskDecoratorSelector>(
    dataToBeValidated: object
  ): Either<WorkflowActionSlackTaskValidationError, DecoratedWorkflowActionSlackTask<T>> {
    const eitherBaseTask = WorkflowActionTaskFactory.validate(dataToBeValidated)

    if (isLeft(eitherBaseTask)) return eitherBaseTask

    const baseTask = eitherBaseTask.right

    if (!hasOwnProperty(dataToBeValidated, "webhookUrl") || typeof dataToBeValidated.webhookUrl !== "string")
      return left("workflow_action_slack_task_webhook_url_missing_or_invalid")

    if (
      !isValidUrl(dataToBeValidated.webhookUrl) ||
      !WorkflowActionSlackTaskFactory.isValidSlackWebhookUrl(dataToBeValidated.webhookUrl)
    )
      return left("workflow_action_slack_task_webhook_url_invalid")

    let message: string | undefined = undefined
    if (hasOwnProperty(dataToBeValidated, "message") && dataToBeValidated.message !== undefined)
      if (typeof dataToBeValidated.message === "string") message = dataToBeValidated.message

    const baseSlackTask: WorkflowActionSlackBaseTaskData = {
      ...baseTask,
      webhookUrl: dataToBeValidated.webhookUrl,
      message
    }

    switch (baseSlackTask.status) {
      case TaskStatus.PENDING:
        return WorkflowActionSlackTaskFactory.validateWorkflowActionSlackPending({
          ...baseSlackTask,
          status: TaskStatus.PENDING
        })
      case TaskStatus.ERROR:
        return WorkflowActionSlackTaskFactory.validateWorkflowActionSlackError({
          ...baseSlackTask,
          status: TaskStatus.ERROR
        })
      case TaskStatus.COMPLETED:
        return WorkflowActionSlackTaskFactory.validateWorkflowActionSlackCompleted({
          ...baseSlackTask,
          status: TaskStatus.COMPLETED
        })
    }
  }

  private static validateWorkflowActionSlackCompleted(
    dataToBeValidated: WorkflowActionSlackBaseTaskData & {
      status: TaskStatus.COMPLETED
    } & {[key: string]: unknown}
  ): Either<WorkflowActionSlackTaskValidationError, WorkflowActionSlackCompletedTaskData> {
    if (!hasOwnProperty(dataToBeValidated, "response"))
      return left("workflow_action_slack_task_completed_with_response_missing" as const)

    const responseValidation = validateResponse(dataToBeValidated.response)
    if (isLeft(responseValidation)) return responseValidation

    return right({...dataToBeValidated, response: responseValidation.right})
  }

  private static validateWorkflowActionSlackPending(
    dataToBeValidated: WorkflowActionSlackBaseTaskData & {
      status: TaskStatus.PENDING
    } & {[key: string]: unknown}
  ): Either<WorkflowActionSlackTaskValidationError, WorkflowActionSlackPendingTaskData> {
    return right(dataToBeValidated)
  }

  private static validateWorkflowActionSlackError(
    dataToBeValidated: WorkflowActionSlackBaseTaskData & {
      status: TaskStatus.ERROR
    } & {[key: string]: unknown}
  ): Either<WorkflowActionSlackTaskValidationError, WorkflowActionSlackErrorTaskData> {
    if (hasOwnProperty(dataToBeValidated, "response") && dataToBeValidated.response !== undefined) {
      const responseValidation = validateResponse(dataToBeValidated.response)
      if (isLeft(responseValidation)) return responseValidation
    }

    return right(dataToBeValidated)
  }

  /**
   * Validates whether the Slack Incoming Webhook URL matches allowed domain prefixes.
   *
   * SECURITY NOTE: This method is a static class method so it can be spied
   * on / mocked in unit and integration testing environments (e.g. to allow wiremock localhost
   * endpoints). Do NOT modify this method to permit local loopback hostnames (like
   * localhost or 127.0.0.1) in production, as doing so introduces critical Server-Side
   * Request Forgery (SSRF) vulnerabilities.
   */
  static isValidSlackWebhookUrl(url: string): boolean {
    return url.startsWith("https://hooks.slack.com")
  }
}

const validateResponse = (response: unknown): Either<WorkflowActionSlackTaskValidationError, HttpResponse> => {
  if (response === null || response === undefined) return left("workflow_action_slack_task_response_invalid" as const)
  if (typeof response !== "object") return left("workflow_action_slack_task_response_invalid" as const)

  const responseAsObject = response as Record<string, unknown>

  if (responseAsObject.status === undefined || typeof responseAsObject.status !== "number")
    return left("workflow_action_slack_task_response_invalid" as const)

  if (responseAsObject.status < 200 || responseAsObject.status > 599)
    return left("workflow_action_slack_task_response_invalid" as const)

  if (responseAsObject.bodyStatus === undefined || typeof responseAsObject.bodyStatus !== "string")
    return left("workflow_action_slack_task_response_invalid" as const)

  const bodyStatus = getStringAsEnum(responseAsObject.bodyStatus, ResponseBodyStatus)
  if (bodyStatus === undefined) return left("workflow_action_slack_task_response_invalid" as const)

  if (bodyStatus === ResponseBodyStatus.OK || bodyStatus === ResponseBodyStatus.TRUNCATED) {
    if (
      responseAsObject.body === undefined ||
      responseAsObject.body === null ||
      typeof responseAsObject.body !== "string"
    )
      return left("workflow_action_slack_task_response_invalid" as const)

    return right({status: responseAsObject.status, bodyStatus, body: responseAsObject.body})
  }

  return right({status: responseAsObject.status, bodyStatus})
}
