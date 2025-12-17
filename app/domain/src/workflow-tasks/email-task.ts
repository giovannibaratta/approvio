import {Either, isLeft, left, right} from "fp-ts/lib/Either"
import {DecorableEntity, PrefixUnion, hasOwnProperty, isDecoratedWith, isEmail} from "@utils"
import {
  Lock,
  TaskStatus,
  WorkflowActionTaskData,
  WorkflowActionTaskFactory,
  WorkflowActionTaskValidationError
} from "./base"
import * as A from "fp-ts/lib/Array"
import * as E from "fp-ts/lib/Either"
import {pipe} from "fp-ts/lib/function"

export type WorkflowActionEmailTask = Readonly<WorkflowActionEmailTaskData>

type WorkflowActionEmailTaskData = WorkflowActionTaskData & {
  recipients: string[]
  subject: string
  body: string
}

export interface WorkflowActionEmailTaskDecorators {
  occ: bigint
  lock: Lock
}

export type WorkflowActionEmailTaskDecoratorSelector = Partial<Record<keyof WorkflowActionEmailTaskDecorators, boolean>>

export type DecoratedWorkflowActionEmailTask<T extends WorkflowActionEmailTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionEmailTask,
  WorkflowActionEmailTaskDecorators,
  T
>

export function isDecoratedWorkflowActionEmailTask<K extends keyof WorkflowActionEmailTaskDecorators>(
  task: DecoratedWorkflowActionEmailTask<WorkflowActionEmailTaskDecoratorSelector>,
  key: K,
  options?: WorkflowActionEmailTaskDecoratorSelector
): task is DecoratedWorkflowActionEmailTask<WorkflowActionEmailTaskDecoratorSelector & Record<K, true>> {
  return isDecoratedWith<
    DecoratedWorkflowActionEmailTask<WorkflowActionEmailTaskDecoratorSelector>,
    WorkflowActionEmailTaskDecorators,
    WorkflowActionEmailTaskDecoratorSelector,
    keyof WorkflowActionEmailTaskDecorators
  >(task, key, options)
}

export type WorkflowActionEmailTaskValidationError =
  | WorkflowActionTaskValidationError
  | PrefixUnion<"workflow_action_email_task", UnprefixedWorkflowActionEmailTaskValidationError>

type UnprefixedWorkflowActionEmailTaskValidationError =
  | "missing_or_invalid_recipients"
  | "missing_or_invalid_subject"
  | "missing_or_invalid_body"
  | "empty_recipients"
  | "empty_subject"
  | "empty_body"
  | "invalid_recipient_type"
  | "invalid_recipient"
  | "invalid_recipients"

export class WorkflowActionEmailTaskFactory {
  static newWorkflowActionEmailTask(
    data: Omit<WorkflowActionEmailTaskData, "status" | "retryCount" | "createdAt" | "updatedAt" | "errorReason">
  ): Either<WorkflowActionEmailTaskValidationError, DecoratedWorkflowActionEmailTask<{occ: true}>> {
    const now = new Date()

    const baseEntity: WorkflowActionEmailTask = {
      ...data,
      status: TaskStatus.PENDING,
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    }

    const decoratedEntity: DecoratedWorkflowActionEmailTask<{occ: true}> = {
      ...baseEntity,
      occ: 0n
    } as DecoratedWorkflowActionEmailTask<{occ: true}>

    return WorkflowActionEmailTaskFactory.validate<{occ: true}>(decoratedEntity)
  }

  static validate<T extends WorkflowActionEmailTaskDecoratorSelector>(
    dataToBeValidated: object
  ): Either<WorkflowActionEmailTaskValidationError, DecoratedWorkflowActionEmailTask<T>> {
    const eitherBaseTask = WorkflowActionTaskFactory.validate(dataToBeValidated)

    if (isLeft(eitherBaseTask)) return eitherBaseTask

    const baseTask = eitherBaseTask.right

    // baseTask only contains the properties of WorkflowActionTaskData, hence we can not use it
    // to validate the email task specific properties

    if (!hasOwnProperty(dataToBeValidated, "recipients") || !Array.isArray(dataToBeValidated.recipients))
      return left("workflow_action_email_task_missing_or_invalid_recipients")

    if (dataToBeValidated.recipients.length === 0) return left("workflow_action_email_task_empty_recipients")

    const eitherRecipients = pipe(
      dataToBeValidated.recipients,
      A.traverse(E.Applicative)(untyped => {
        if (typeof untyped !== "string") return left("workflow_action_email_task_invalid_recipient_type" as const)
        if (!isEmail(untyped)) return left("workflow_action_email_task_invalid_recipient" as const)
        return right(untyped)
      })
    )

    if (isLeft(eitherRecipients)) return eitherRecipients

    const recipients = eitherRecipients.right

    if (!hasOwnProperty(dataToBeValidated, "subject") || typeof dataToBeValidated.subject !== "string")
      return left("workflow_action_email_task_missing_or_invalid_subject")

    if (dataToBeValidated.subject.trim().length === 0) return left("workflow_action_email_task_empty_subject")

    if (!hasOwnProperty(dataToBeValidated, "body") || typeof dataToBeValidated.body !== "string")
      return left("workflow_action_email_task_missing_or_invalid_body")

    if (dataToBeValidated.body.trim().length === 0) return left("workflow_action_email_task_empty_body")

    return right({
      ...baseTask,
      recipients,
      subject: dataToBeValidated.subject.trim(),
      body: dataToBeValidated.body.trim()
    })
  }
}
