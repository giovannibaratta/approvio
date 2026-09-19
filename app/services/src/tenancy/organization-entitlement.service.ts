import {Inject, Injectable} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
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
        // TODO: Why we are doing this ? Usually we map to unknown error in the controller, and we raise them in the persistnce when they are generated externally
