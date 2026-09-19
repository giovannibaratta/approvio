import {TIER_DEFAULTS, TenantContext} from "@domain"
import {ConfigProvider} from "@external/config"
import {Injectable} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {EffectiveEntitlements, FeatureGateError, FeatureKey} from "./interfaces"
import {isUUIDv7} from "@utils"
import {OrganizationEntitlementService} from "../tenancy/organization-entitlement.service"
import {pipe} from "fp-ts/function"

@Injectable()
export class FeatureGateService {
  constructor(
    private readonly configProvider: ConfigProvider,
    private readonly entitlements: OrganizationEntitlementService
  ) {}

  /**
   * Evaluates whether a specific feature is enabled in the current deployment environment.
   *
   * Feature availability is resolved from the target organization's persisted plan tier.
   *
   * @param feature - The feature key to inspect (e.g., 'platformLlmEvaluators').
   * @returns TaskEither resolving to `true` if enabled, `false` otherwise.
   */
  public isFeatureEnabled(
    context: TenantContext,
    feature: FeatureKey
  ): TE.TaskEither<FeatureGateError | "invalid_organization_id", boolean> {
    return pipe(
      this.getEffectiveEntitlements(context),
      TE.map(entitlement => entitlement.features[feature])
    )
  }

  /**
   * Retrieves the effective entitlements (deployment edition, active plan tier, and feature map).
   *
   * @param context - The organization whose entitlements are being resolved.
   * @returns TaskEither resolving to the EffectiveEntitlements.
   */
  public getEffectiveEntitlements(
    context: TenantContext
  ): TE.TaskEither<FeatureGateError | "invalid_organization_id", EffectiveEntitlements> {
    if (!isUUIDv7(context.organizationId)) return TE.left("invalid_organization_id")

    return pipe(
      this.entitlements.getPlanTier(context),
      TE.map(planTier => ({
        edition: this.configProvider.deploymentEdition,
        planTier,
        features: TIER_DEFAULTS[planTier].features
      }))
    )
  }
}
