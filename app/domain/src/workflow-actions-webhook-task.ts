import {Either, isLeft, left, right} from "fp-ts/lib/Either"
import {DecorableEntity, PrefixUnion, getStringAsEnum, hasOwnProperty, isRecordStringString, isValidUrl} from "@utils"
import {
  TaskStatus,
  WorkflowActionTaskData,
  WorkflowActionPendingTaskData,
  WorkflowActionCompletedTaskData,
  WorkflowActionErrorTaskData,
  WorkflowActionTaskDecoratorSelector,
  WorkflowActionTaskDecorators,
  WorkflowActionTaskFactory,
  WorkflowActionTaskValidationError
} from "./workflow-actions-shared"
import {WebhookActionHttpMethod} from "./workflow-actions"

export enum ResponseBodyStatus {
  OK = "OK",
  MISSING = "MISSING",
  BINARY_DATA = "BINARY_DATA",
  TRUNCATED = "TRUNCATED",
  PROCESSING_FAILED = "PROCESSING_FAILED"
}

export type DecoratedWorkflowActionWebhookTask<T extends WorkflowActionTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionWebhookTaskData,
  WorkflowActionTaskDecorators,
  T
>

export type DecoratedWorkflowActionWebhookPendingTask<T extends WorkflowActionTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionWebhookPendingTaskData,
  WorkflowActionTaskDecorators,
  T
>

export type DecoratedWorkflowActionWebhookCompletedTask<T extends WorkflowActionTaskDecoratorSelector> =
  DecorableEntity<WorkflowActionWebhookCompletedTaskData, WorkflowActionTaskDecorators, T>

export type DecoratedWorkflowActionWebhookErrorTask<T extends WorkflowActionTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionWebhookErrorTaskData,
  WorkflowActionTaskDecorators,
  T
>

export type WorkflowActionWebhookTaskData =
  | WorkflowActionWebhookPendingTaskData
  | WorkflowActionWebhookCompletedTaskData
  | WorkflowActionWebhookErrorTaskData

type WorkflowActionWebhookBaseTaskData = WorkflowActionTaskData & {
  url: string
  method: WebhookActionHttpMethod
  headers?: Record<string, string>
  payload?: unknown
}

type WorkflowActionWebhookPendingTaskData = WorkflowActionWebhookBaseTaskData & WorkflowActionPendingTaskData

type WorkflowActionWebhookCompletedTaskData = WorkflowActionWebhookBaseTaskData &
  WorkflowActionCompletedTaskData & {response: WebhookResponse}

type WorkflowActionWebhookErrorTaskData = WorkflowActionWebhookBaseTaskData &
  WorkflowActionErrorTaskData & {
    response?: WebhookResponse
  }

export interface WebhookResponse {
  status: number
  body?: string
  bodyStatus: ResponseBodyStatus
}

export type WorkflowActionWebhookTaskValidationError =
  | WorkflowActionTaskValidationError
  | PrefixUnion<"workflow_action_webhook_task", UnprefixedWorkflowActionWebhookTaskValidationError>

type UnprefixedWorkflowActionWebhookTaskValidationError =
  | "method_invalid"
  | "completed_with_error_reason"
  | "completed_with_response_missing"
  | "response_invalid"
  | "pending_with_non_zero_retry_count"
  | "pending_with_error_reason"
  | "error_with_zero_retry_count"
  | "error_with_error_reason_missing"
  | "error_with_optional_response_missing"
  | "method_missing_or_invalid"
  | "url_missing_or_invalid"
  | "url_invalid"
  | "headers_invalid"

export class WorkflowActionWebhookTaskFactory {
  static newWorkflowActionWebhookTask(
    data: Omit<
      WorkflowActionWebhookPendingTaskData,
      "status" | "retryCount" | "createdAt" | "updatedAt" | "errorReason"
    >
  ): Either<WorkflowActionWebhookTaskValidationError, DecoratedWorkflowActionWebhookPendingTask<{occ: true}>> {
    const now = new Date()

    const entity: DecoratedWorkflowActionWebhookPendingTask<{occ: true}> = {
      ...data,
      status: TaskStatus.PENDING,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      occ: 0n
    }

    const validated = WorkflowActionWebhookTaskFactory.validate<{occ: true}>(entity)

    if (isLeft(validated)) return validated

    return right(entity)
  }

  static toFailedWebhook<T extends WorkflowActionTaskDecoratorSelector>(
    task: DecoratedWorkflowActionWebhookTask<T>,
    newData: {
      response: WebhookResponse | null
      errorReason: string
    }
  ): Either<WorkflowActionWebhookTaskValidationError, DecoratedWorkflowActionWebhookTask<T>> {
    const newObj = {
      ...task,
      updatedAt: new Date(),
      retryCount: task.retryCount + 1,
      errorReason: newData.errorReason,
      optionalResponse: newData.response ? newData.response : undefined
    }

    return WorkflowActionWebhookTaskFactory.validate({
      ...newObj,
      status: TaskStatus.ERROR
    })
  }

  static toCompletedWebhook<T extends WorkflowActionTaskDecoratorSelector>(
    task: DecoratedWorkflowActionWebhookTask<T>,
    newData: {
      response: WebhookResponse
    }
  ): Either<WorkflowActionWebhookTaskValidationError, DecoratedWorkflowActionWebhookTask<T>> {
    const newObj /*: DecoratedWorkflowActionWebhookTask<T>*/ = {
      ...task,
      updatedAt: new Date(),
      retryCount: task.retryCount + 1,
      response: newData.response,
      errorReason: undefined
    }

    return WorkflowActionWebhookTaskFactory.validate({
      ...newObj,
      status: TaskStatus.COMPLETED
    })
  }

  static validate<T extends WorkflowActionTaskDecoratorSelector>(
    dataToBeValidated: object
  ): Either<WorkflowActionWebhookTaskValidationError, DecoratedWorkflowActionWebhookTask<T>> {
    const eitherBaseTask = WorkflowActionTaskFactory.validate(dataToBeValidated)

    if (isLeft(eitherBaseTask)) return eitherBaseTask

    const baseTask = eitherBaseTask.right

    // baseTask only contains the properties of WorkflowActionTaskData, hence we can not use it
    // to validate the webhook task specific properties

    if (!hasOwnProperty(dataToBeValidated, "method") || typeof dataToBeValidated.method !== "string")
      return left("workflow_action_webhook_task_method_missing_or_invalid")

    const methodValidation = validateMethod(dataToBeValidated.method)
    if (isLeft(methodValidation)) return methodValidation

    if (!hasOwnProperty(dataToBeValidated, "url") || typeof dataToBeValidated.url !== "string")
      return left("workflow_action_webhook_task_url_missing_or_invalid")

    if (!isValidUrl(dataToBeValidated.url)) return left("workflow_action_webhook_task_url_invalid")

    let headers: Record<string, string> | undefined = undefined
    let payload: unknown = undefined

    if (hasOwnProperty(dataToBeValidated, "headers")) {
      if (dataToBeValidated.headers !== undefined && !isRecordStringString(dataToBeValidated.headers))
        return left("workflow_action_webhook_task_headers_invalid")
      headers = dataToBeValidated.headers
    }

    if (hasOwnProperty(dataToBeValidated, "payload")) payload = dataToBeValidated.payload

    const baseWebhookTask: WorkflowActionWebhookBaseTaskData = {
      ...baseTask,
      method: methodValidation.right,
      url: dataToBeValidated.url,
      headers,
      payload
    }

    if (baseWebhookTask.status === TaskStatus.PENDING) {
      return WorkflowActionWebhookTaskFactory.validateWorkflowActionWebhookPending({
        ...baseWebhookTask,
        status: TaskStatus.PENDING
      })
    }

    if (baseWebhookTask.status === TaskStatus.ERROR) {
      return WorkflowActionWebhookTaskFactory.validateWorkflowActionWebhookError({
        ...baseWebhookTask,
        status: TaskStatus.ERROR
      })
    }

    if (baseWebhookTask.status === TaskStatus.COMPLETED) {
      return WorkflowActionWebhookTaskFactory.validateWorkflowActionWebhookCompleted({
        ...baseWebhookTask,
        status: TaskStatus.COMPLETED
      })
    }

    throw new Error("Invalid task status, this is a bug")
  }

  private static validateWorkflowActionWebhookCompleted(
    dataToBeValidated: WorkflowActionWebhookBaseTaskData & {
      status: TaskStatus.COMPLETED
    } & {[key: string]: unknown}
  ): Either<WorkflowActionWebhookTaskValidationError, WorkflowActionWebhookCompletedTaskData> {
    if (!hasOwnProperty(dataToBeValidated, "response"))
      return left("workflow_action_webhook_task_completed_with_response_missing" as const)

    const responseValidation = validateResponse(dataToBeValidated.response)
    if (isLeft(responseValidation)) return responseValidation

    return right({...dataToBeValidated, response: responseValidation.right})
  }

  private static validateWorkflowActionWebhookPending(
    dataToBeValidated: WorkflowActionWebhookBaseTaskData & {
      status: TaskStatus.PENDING
    } & {[key: string]: unknown}
  ): Either<WorkflowActionWebhookTaskValidationError, WorkflowActionWebhookPendingTaskData> {
    return right(dataToBeValidated)
  }

  private static validateWorkflowActionWebhookError(
    dataToBeValidated: WorkflowActionWebhookBaseTaskData & {
      status: TaskStatus.ERROR
    } & {[key: string]: unknown}
  ): Either<WorkflowActionWebhookTaskValidationError, WorkflowActionWebhookErrorTaskData> {
    if (hasOwnProperty(dataToBeValidated, "response") && dataToBeValidated.response !== undefined) {
      const responseValidation = validateResponse(dataToBeValidated.response)
      if (isLeft(responseValidation)) return responseValidation
    }

    return right(dataToBeValidated)
  }
}

const validateMethod = (method: string): Either<WorkflowActionWebhookTaskValidationError, WebhookActionHttpMethod> => {
  const enumMethod = getStringAsEnum(method, WebhookActionHttpMethod)
  if (enumMethod === undefined) return left("workflow_action_webhook_task_method_invalid")
  return right(enumMethod)
}

const validateResponse = (response: unknown): Either<WorkflowActionWebhookTaskValidationError, WebhookResponse> => {
  if (typeof response !== "object") return left("workflow_action_webhook_task_response_invalid" as const)
  if (response === null) return left("workflow_action_webhook_task_response_invalid" as const)

  const responseAsObject = response as Record<string, unknown>

  if (responseAsObject.status === undefined || typeof responseAsObject.status !== "number")
    return left("workflow_action_webhook_task_response_invalid" as const)

  if (responseAsObject.status < 200 || responseAsObject.status > 599)
    return left("workflow_action_webhook_task_response_invalid" as const)

  if (responseAsObject.bodyStatus === undefined || typeof responseAsObject.bodyStatus !== "string")
    return left("workflow_action_webhook_task_response_invalid" as const)

  const bodyStatus = getStringAsEnum(responseAsObject.bodyStatus, ResponseBodyStatus)
  if (bodyStatus === undefined) return left("workflow_action_webhook_task_response_invalid" as const)

  if (bodyStatus === ResponseBodyStatus.OK || bodyStatus === ResponseBodyStatus.TRUNCATED) {
    if (responseAsObject.body !== undefined) return left("workflow_action_webhook_task_response_invalid" as const)
    return right({status: responseAsObject.status, bodyStatus, body: responseAsObject.body})
  }

  return right({status: responseAsObject.status, bodyStatus})
}
