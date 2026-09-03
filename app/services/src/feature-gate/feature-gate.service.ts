import {TIER_DEFAULTS} from "@domain"
import {ConfigProvider} from "@external/config"
import {Injectable} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {EffectiveEntitlements, FeatureGateError, FeatureKey} from "./interfaces"

@Injectable()
export class FeatureGateService {
  constructor(private readonly configProvider: ConfigProvider) {}

  /**
   * Evaluates whether a specific feature is enabled in the current deployment environment.
   *
   * In self-hosted mode (`DEPLOYMENT_EDITION=self_hosted`), all features are enabled unconditionally.
   * In SaaS cloud mode (`DEPLOYMENT_EDITION=saas_cloud`), feature availability is resolved against
   * the active commercial plan tier's baseline defaults (`TIER_DEFAULTS[planTier].features`).
   *
   * @param feature - The feature key to inspect (e.g., 'platformLlmEvaluators').
   * @returns TaskEither resolving to `true` if enabled, `false` otherwise.
   */
  public isFeatureEnabled(feature: FeatureKey): TE.TaskEither<FeatureGateError, boolean> {
    if (this.configProvider.deploymentEdition === "self_hosted") return TE.right(true)

    const tierConfig = TIER_DEFAULTS[this.configProvider.planTier]
    return TE.right(tierConfig.features[feature])
  }

  /**
   * Retrieves the effective entitlements (deployment edition, active plan tier, and feature map).
   *
   * @param _orgId - Optional organization UUID.
   * @returns TaskEither resolving to the EffectiveEntitlements.
   */
  public getEffectiveEntitlements(_orgId?: string): TE.TaskEither<FeatureGateError, EffectiveEntitlements> {
    if (this.configProvider.deploymentEdition === "self_hosted")
      return TE.right({
        edition: "self_hosted",
        planTier: "SELF_HOSTED_UNLIMITED",
        features: TIER_DEFAULTS.SELF_HOSTED_UNLIMITED.features
      })

    // TODO(long-term): once multi-org support is implemented, the org id should be use to fetch
    // the actual tier for the org from the DB.
    const planTier = this.configProvider.planTier
    const tierConfig = TIER_DEFAULTS[planTier]
    return TE.right({
      edition: "saas_cloud",
      planTier,
      features: tierConfig.features
    })
  }
}
