import {TIER_DEFAULTS, PlanTier} from "../src/tier"

describe("Subscription Tiers (`tier.ts`)", () => {
  it("should ensure TIER_DEFAULTS covers all PlanTier values", () => {
    // Given
    const definedTiers: PlanTier[] = ["FREE", "SELF_HOSTED_UNLIMITED"]

    // When
    const configs = definedTiers.map(tier => TIER_DEFAULTS[tier])

    // Expect
    configs.forEach(tierConfig => {
      expect(tierConfig).toBeDefined()
      expect(tierConfig.name).toBeDefined()
      expect(tierConfig.quotas).toBeDefined()
      expect(tierConfig.features).toBeDefined()
    })
  })
})
