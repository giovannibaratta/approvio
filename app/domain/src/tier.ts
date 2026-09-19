import type {SupportedQuotaType} from "./quota"

export type PlanTier = "FREE" | "SELF_HOSTED_UNLIMITED"

export function isPlanTier(value: unknown): value is PlanTier {
  return value === "FREE" || value === "SELF_HOSTED_UNLIMITED"
}

export type TierQuotaLimit = bigint | "UNLIMITED"

export type TierQuotas = Record<SupportedQuotaType, TierQuotaLimit>

export interface TierFeatures {
  readonly platformLlmEvaluators: boolean
}

export interface TierDefinition {
  readonly name: string
  readonly quotas: TierQuotas
  readonly features: TierFeatures
}

export const TIER_DEFAULTS: Record<PlanTier, TierDefinition> = {
  FREE: {
    name: "Free",
    quotas: {
      MAX_SPACES: 3n,
      MAX_GROUPS: 5n,
      MAX_ENTITIES_PER_GROUP: 10n,
      MAX_WORKFLOW_TEMPLATES_PER_SPACE: 10n,
      MAX_CONCURRENT_WORKFLOWS: 2n,
      MAX_VOTES_PER_WORKFLOW: 50n,
      MAX_ROLES_PER_USER: 5n,
      MAX_LLM_TOKENS_PER_MONTH: 0n,
      MAX_EVALUATIONS_PER_MONTH: 0n,
      MAX_CREDITS_PER_MONTH: 0n
    },
    features: {
      platformLlmEvaluators: false
    }
  },
  SELF_HOSTED_UNLIMITED: {
    name: "Self-Hosted Unlimited",
    quotas: {
      MAX_SPACES: "UNLIMITED",
      MAX_GROUPS: "UNLIMITED",
      MAX_ENTITIES_PER_GROUP: "UNLIMITED",
      MAX_WORKFLOW_TEMPLATES_PER_SPACE: "UNLIMITED",
      MAX_CONCURRENT_WORKFLOWS: "UNLIMITED",
      MAX_VOTES_PER_WORKFLOW: "UNLIMITED",
      MAX_ROLES_PER_USER: "UNLIMITED",
      MAX_LLM_TOKENS_PER_MONTH: "UNLIMITED",
      MAX_EVALUATIONS_PER_MONTH: "UNLIMITED",
      MAX_CREDITS_PER_MONTH: "UNLIMITED"
    },
    features: {
      platformLlmEvaluators: true
    }
  }
}
