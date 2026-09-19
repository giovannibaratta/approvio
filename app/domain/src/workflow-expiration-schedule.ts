import {Brand, brand, isObject} from "@utils"
import {Either, left, right} from "fp-ts/Either"
import {isOrganizationId, OrganizationId} from "./shared"

interface WorkflowExpirationScheduleProps {
  readonly organizationId: OrganizationId
  readonly lastSweptAt?: Date
}

declare const _WorkflowExpirationScheduleBrand: unique symbol
export type WorkflowExpirationSchedule = Brand<WorkflowExpirationScheduleProps, typeof _WorkflowExpirationScheduleBrand>

export type WorkflowExpirationScheduleValidationError =
  | "workflow_expiration_schedule_malformed_object"
  | "workflow_expiration_schedule_invalid_organization_id"
  | "workflow_expiration_schedule_invalid_last_swept_at"

/** Validated sweep history; due selection and scheduling decisions remain service operations. */
export class WorkflowExpirationScheduleFactory {
  static validate(data: unknown): Either<WorkflowExpirationScheduleValidationError, WorkflowExpirationSchedule> {
    if (!isObject(data)) return left("workflow_expiration_schedule_malformed_object")
    const {organizationId, lastSweptAt} = data
    if (!isOrganizationId(organizationId)) return left("workflow_expiration_schedule_invalid_organization_id")
    if (lastSweptAt !== undefined && (!(lastSweptAt instanceof Date) || Number.isNaN(lastSweptAt.getTime())))
      return left("workflow_expiration_schedule_invalid_last_swept_at")

    return right(
      brand<WorkflowExpirationScheduleProps, typeof _WorkflowExpirationScheduleBrand>({organizationId, lastSweptAt})
    )
  }
}
