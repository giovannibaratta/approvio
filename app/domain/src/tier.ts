import {SupportedQuotaType} from "./quota"

export type PlanTier = "FREE" | "SELF_HOSTED_UNLIMITED"

export type TierQuotaLimit = number | "UNLIMITED"

export interface TierFeatures {
  readonly platformLlmEvaluators: boolean
}

export interface TierDefinition {
  readonly name: string
  readonly quotas: Record<SupportedQuotaType, TierQuotaLimit>
  readonly features: TierFeatures
}

export const TIER_DEFAULTS: Record<PlanTier, TierDefinition> = {
  FREE: {
    name: "Free",
    quotas: {
      MAX_SPACES: 3,
      MAX_GROUPS: 5,
      MAX_ENTITIES_PER_GROUP: 10,
      MAX_WORKFLOW_TEMPLATES_PER_SPACE: 10,
      MAX_CONCURRENT_WORKFLOWS: 2,
      MAX_VOTES_PER_WORKFLOW: 50,
      MAX_ROLES_PER_USER: 5,
      MAX_LLM_TOKENS_PER_MONTH: 0,
      MAX_EVALUATIONS_PER_MONTH: 0,
      MAX_CREDITS_PER_MONTH: 0
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
