import {getStringAsEnum, isEmail, isObject, isValidUrl, PrefixUnion} from "@utils"
import {Either, left, right, traverseArray} from "fp-ts/lib/Either"

export enum WebhookActionHttpMethod {
  GET = "GET",
  POST = "POST",
  PUT = "PUT"
}

export enum WorkflowActionType {
  EMAIL = "EMAIL",
  WEBHOOK = "WEBHOOK"
}

export type WorkflowAction = EmailAction | WebhookAction

export type EmailAction = Readonly<{
  type: WorkflowActionType.EMAIL
  recipients: ReadonlyArray<string>
}>

export type WebhookAction = Readonly<{
  type: WorkflowActionType.WEBHOOK
  url: string
  method: WebhookActionHttpMethod
  headers?: Record<string, string>
}>

export type WorkflowActionValidationError = PrefixUnion<"workflow_action", UnprefixedWorkflowActionValidationError>

type UnprefixedWorkflowActionValidationError =
  | "type_invalid"
  | "recipients_empty"
  | "recipients_invalid_email"
  | "url_invalid"
  | "method_invalid"
  | "missing_http_method"
  | "headers_invalid"

export function validateWorkflowActions(
  actions: unknown
): Either<WorkflowActionValidationError, ReadonlyArray<WorkflowAction>> {
  if (!Array.isArray(actions)) return right([])

  return traverseArray(validateWorkflowAction)(actions)
}

function validateWorkflowAction(action: unknown): Either<WorkflowActionValidationError, WorkflowAction> {
  if (!isObject(action) || typeof action.type !== "string") return left("workflow_action_type_invalid")

  const actionType = getStringAsEnum(action.type, WorkflowActionType)
  if (actionType === undefined) return left("workflow_action_type_invalid")

  switch (actionType) {
    case WorkflowActionType.EMAIL:
      return validateEmailAction(action)
    case WorkflowActionType.WEBHOOK:
      return validateWebhookAction(action)
  }
}

function validateWebhookAction(data: Record<string, unknown>): Either<WorkflowActionValidationError, WebhookAction> {
  if (typeof data.url !== "string" || !isValidUrl(data.url)) return left("workflow_action_url_invalid")
  if (data.method === undefined) return left("workflow_action_missing_http_method")
  if (typeof data.method !== "string") return left("workflow_action_method_invalid")

  const method = getStringAsEnum(data.method, WebhookActionHttpMethod)
  if (method === undefined) return left("workflow_action_method_invalid")

  if (data.headers !== undefined && !isObject(data.headers)) return left("workflow_action_headers_invalid")

  // Validate that all header values are strings
  if (data.headers !== undefined) {
    for (const key in data.headers) {
      if (typeof data.headers[key] !== "string") return left("workflow_action_headers_invalid")
    }
  }

  return right({
    type: WorkflowActionType.WEBHOOK,
    url: data.url,
    method,
    headers: data.headers as Record<string, string> | undefined
  })
}

function validateEmailAction(data: Record<string, unknown>): Either<WorkflowActionValidationError, EmailAction> {
  if (!Array.isArray(data.recipients) || data.recipients.length === 0) {
    return left("workflow_action_recipients_empty")
  }

  for (const recipient of data.recipients) {
    if (typeof recipient !== "string" || !isEmail(recipient)) {
      return left("workflow_action_recipients_invalid_email")
    }
  }

  return right({
    type: WorkflowActionType.EMAIL,
    recipients: data.recipients,
    subject: data.subject,
    body: data.body
  })
}
