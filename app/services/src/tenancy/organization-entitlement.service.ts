import {Inject, Injectable} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "../transaction/interfaces"
import {
  ORGANIZATION_ENTITLEMENT_REPOSITORY_TOKEN,
  OrganizationEntitlementRepository,
  OrganizationPlanTierError
} from "./interfaces"
import {PlanTier, TenantContext} from "@domain"

@Injectable()
export class OrganizationEntitlementService {
  constructor(
    @Inject(ORGANIZATION_ENTITLEMENT_REPOSITORY_TOKEN) private readonly repository: OrganizationEntitlementRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly txManager: TenantTransactionManager
  ) {}

  getPlanTier(context: TenantContext): TE.TaskEither<OrganizationPlanTierError, PlanTier> {
    return this.txManager.execute(context, () => this.repository.getPlanTier(context))
  }
}
