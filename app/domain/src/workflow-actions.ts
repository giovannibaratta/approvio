import {getStringAsEnum, isEmail, isObject} from "@utils"
import {Either, left, right, traverseArray} from "fp-ts/lib/Either"

export enum WorkflowActionType {
  EMAIL = "EMAIL"
}

export type WorkflowAction = EmailAction

export type EmailAction = Readonly<{
  type: WorkflowActionType.EMAIL
  recipients: ReadonlyArray<string>
}>

export function validateWorkflowActions(
  actions: unknown
): Either<WorkflowActionValidationError, ReadonlyArray<WorkflowAction>> {
  if (!Array.isArray(actions)) return right([])

  return traverseArray(validateWorkflowAction)(actions)
}

function validateWorkflowAction(action: unknown): Either<WorkflowActionValidationError, WorkflowAction> {
  if (!isObject(action) || typeof action.type !== "string") {
    return left("action_type_invalid")
  }

  const actionType = getStringAsEnum(action.type, WorkflowActionType)
  if (actionType === undefined) return left("action_type_invalid")

  switch (actionType) {
    case WorkflowActionType.EMAIL:
      return validateEmailAction(action)
    default:
      return left("action_type_invalid")
  }
}

function validateEmailAction(data: Record<string, unknown>): Either<WorkflowActionValidationError, EmailAction> {
  if (!Array.isArray(data.recipients) || data.recipients.length === 0) {
    return left("action_recipients_empty")
  }

  for (const recipient of data.recipients) {
    if (typeof recipient !== "string" || !isEmail(recipient)) {
      return left("action_recipients_invalid_email")
    }
  }

  return right({
    type: WorkflowActionType.EMAIL,
    recipients: data.recipients,
    subject: data.subject,
    body: data.body
  })
}

export type WorkflowActionValidationError =
  | "action_type_invalid"
  | "action_recipients_empty"
  | "action_recipients_invalid_email"
