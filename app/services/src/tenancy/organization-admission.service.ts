import {Inject, Injectable} from "@nestjs/common"
import {AuthenticatedEntity, BoundaryError, OrgRole, TenantContext} from "@domain"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {TenantTransactionManager, TRANSACTION_MANAGER_TOKEN, TransactionError} from "../transaction/interfaces"
import {
  ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN,
  OrganizationDirectoryRepository,
  OrganizationSummary
} from "./interfaces"
import {RepositoryDependencyError} from "../error"

/** Operation policy used when admitting a request to an organization. */
export type OrganizationAdmissionOperation =
  "tenant_operation" | "get_organization" | "resume_organization" | "delete_organization"

export type OrganizationAdmissionError =
  | "organization_suspended"
  | "organization_deleting"
  | "permission_denied"
  | BoundaryError
  | "organization_not_found"
  | RepositoryDependencyError
  | TransactionError

/** Checks organization lifecycle access using the requestor resolved during JWT authentication. */
@Injectable()
export class OrganizationAdmissionService {
  constructor(
    @Inject(ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN) private readonly organizations: OrganizationDirectoryRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly transactions: TenantTransactionManager
  ) {}

  admit(
    context: TenantContext,
    entity: AuthenticatedEntity,
    operation: OrganizationAdmissionOperation
  ): TE.TaskEither<OrganizationAdmissionError, void> {
    return pipe(
      this.transactions.execute(context, () => this.organizations.get(context)),
      TE.chainEitherKW(organization => authorizeOrganizationOperation(organization, entity, operation))
    )
  }
}

function authorizeOrganizationOperation(
  organization: OrganizationSummary,
  entity: AuthenticatedEntity,
  operation: OrganizationAdmissionOperation
): E.Either<"organization_suspended" | "organization_deleting" | "organization_not_found", void> {
  switch (organization.status) {
    case "active":
      return E.right(undefined)
    case "deleting":
      return E.left("organization_deleting")
    case "deleted":
      return E.left("organization_not_found")
    case "suspended":
      if (entity.entityType !== "user") return E.left("organization_suspended")
      switch (operation) {
        case "get_organization":
          return entity.user.orgRole !== OrgRole.MEMBER ? E.right(undefined) : E.left("organization_suspended")
        case "resume_organization":
        case "delete_organization":
          return entity.user.orgRole === OrgRole.OWNER ? E.right(undefined) : E.left("organization_suspended")
        case "tenant_operation":
          return E.left("organization_suspended")
      }
  }
}
