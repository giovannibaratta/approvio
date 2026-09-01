import {PlanTier, TierFeatures} from "@domain"
import {UnknownError} from "../error"

export type FeatureKey = keyof TierFeatures

export type DeploymentEdition = "self_hosted" | "saas_cloud"

export interface EffectiveEntitlements {
  readonly edition: DeploymentEdition
  readonly planTier: PlanTier
  readonly features: TierFeatures
}

export type FeatureGateError = UnknownError
