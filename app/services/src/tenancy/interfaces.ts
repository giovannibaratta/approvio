// TODO: This file contains several interfaces, are we overloading it ?
import {TaskEither} from "fp-ts/TaskEither"
import {
  Account,
  Actor,
  AdmissionOperation,
  AuthorityError,
  BoundaryError,
  Credential,
  Invitation,
  MutationError,
  OrgRole,
  OrgStatus,
  Session,
  StepUpReceipt,
  SuspensionReason,
  TenantContext,
  TenantPrincipal,
  User
} from "@domain"
import {RepositoryDependencyError} from "../error"

// TODO: Isn't this a domain model ?
export interface OrganizationSummary {
  readonly id: string
  readonly slug: string
  readonly displayName: string
  readonly status: OrgStatus
  readonly occ: string
}
