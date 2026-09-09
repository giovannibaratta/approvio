import {BoundaryError, PlanTier, TenantContext, TierFeatures} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {UnknownError} from "../error"

export type FeatureKey = keyof TierFeatures

export type DeploymentEdition = "self_hosted" | "saas_cloud"

export interface EffectiveEntitlements {
  readonly edition: DeploymentEdition
  readonly planTier: PlanTier
  readonly features: TierFeatures
}

export type FeatureGateError = UnknownError

export interface FeatureGate {
  isFeatureEnabled(context: TenantContext, feature: FeatureKey): TaskEither<FeatureGateError | BoundaryError, boolean>
  getEffectiveEntitlements(context: TenantContext): TaskEither<FeatureGateError | BoundaryError, EffectiveEntitlements>
}
