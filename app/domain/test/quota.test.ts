import {
  QuotaFactory,
  QuotaIdentifierFactory,
  isQuotaTypeApplicableTo,
  resolveEffectiveLimit,
  SupportedQuotaType
} from "../src/quota"
import {Chance} from "chance"
import {v7 as uuidv7} from "uuid"
import {unwrapRight} from "@utils/either"

const chance = Chance()

describe("isMetricApplicableTo", () => {
  it("should return true if metric is exactly for the node type", () => {
    // Given
    const quotaType = "MAX_WORKFLOW_TEMPLATES_PER_SPACE"
    const nodeType = "Space"

    // When
    const isApplicable = isQuotaTypeApplicableTo(quotaType, nodeType)

    // Then
    expect(isApplicable).toBe(true)
  })

  it("should return false if node type is a parent", () => {
    // Given
    const quotaType = "MAX_WORKFLOW_TEMPLATES_PER_SPACE"
    const nodeType = "Org"

    // When
    const isApplicable = isQuotaTypeApplicableTo(quotaType, nodeType)

    // Then
    expect(isApplicable).toBe(false)
  })

  it("should return false if node type is a descendant", () => {
    // Given
    const quotaType = "MAX_WORKFLOW_TEMPLATES_PER_SPACE"
    const nodeType = "WorkflowTemplate"

    // When
    const isApplicable = isQuotaTypeApplicableTo(quotaType, nodeType)

    // Then
    expect(isApplicable).toBe(false)
  })
})

describe("QuotaIdentifierFactory", () => {
  describe("validate", () => {
    describe("good cases", () => {
      it("should validate a valid identifier with exact node type match", () => {
        // Given
        const identifier = uuidv7()
        const data = {
          node: {type: "Space", identifier},
          quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE"
        }

        // When
        const result = QuotaIdentifierFactory.validate(data)

        // Then
        expect(result).toBeRight()
      })

      it("should validate an identifier where node is a parent of the metric's base type", () => {
        // Given
        const data = {
          node: {type: "Org", identifier: uuidv7()},
          quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE"
        }

        // When
        const result = QuotaIdentifierFactory.validate(data)

        // Then
        expect(result).toBeRight()
      })

      it("should validate metered quota types for Org node", () => {
        // Given
        const meteredMetrics = [
          "MAX_LLM_TOKENS_PER_MONTH",
          "MAX_EVALUATIONS_PER_MONTH",
          "MAX_CREDITS_PER_MONTH"
        ] as const

        // When & Then
        meteredMetrics.forEach(metric => {
          const data = {
            node: {type: "Org", identifier: uuidv7()},
            quotaType: metric
          }
          const result = QuotaIdentifierFactory.validate(data)
          expect(result).toBeRight()
        })
      })
    })

    describe("bad cases", () => {
      it("should fail if data is not an object", () => {
        // Given
        const data1 = null
        const data2 = "string"

        // When
        const result1 = QuotaIdentifierFactory.validate(data1)
        const result2 = QuotaIdentifierFactory.validate(data2)

        // Then
        expect(result1).toBeLeftOf("quota_invalid_format")
        expect(result2).toBeLeftOf("quota_invalid_format")
      })

      it("should fail if node is missing or invalid", () => {
        // Given
        const data1 = {quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE"}
        const data2 = {node: "invalid", quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE"}

        // When
        const result1 = QuotaIdentifierFactory.validate(data1)
        const result2 = QuotaIdentifierFactory.validate(data2)

        // Then
        expect(result1).toBeLeftOf("quota_invalid_format")
        expect(result2).toBeLeftOf("quota_invalid_format")
      })

      it("should fail if node type is invalid", () => {
        // Given
        const data = {
          node: {type: "InvalidType", identifier: uuidv7()},
          quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE"
        }

        // When
        const result = QuotaIdentifierFactory.validate(data)

        // Then
        expect(result).toBeLeftOf("quota_invalid_node_type")
      })

      it("should fail if node identifier is missing", () => {
        // Given
        const data = {
          node: {type: "Space"},
          quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE"
        }

        // When
        const result = QuotaIdentifierFactory.validate(data)

        // Then
        expect(result).toBeLeftOf("quota_invalid_target_id")
      })

      it("should fail if metric is not supported", () => {
        // Given
        const data = {
          node: {type: "Space", identifier: uuidv7()},
          quotaType: "INVALID_METRIC"
        }

        // When
        const result = QuotaIdentifierFactory.validate(data)

        // Then
        expect(result).toBeLeftOf("quota_unsupported_quota_type")
      })

      it("should fail if metric is not supported at node type", () => {
        // Given
        const data = {
          node: {type: "User", identifier: uuidv7()},
          quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE"
        }

        // When
        const result = QuotaIdentifierFactory.validate(data)

        // Then
        expect(result).toBeLeftOf("quota_unsupported_node_type")
      })

      it("should fail if identifier is not a uuid", () => {
        // Given
        const data = {
          node: {type: "Space", identifier: "invalid-uuid"},
          quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE"
        }

        // When
        const result = QuotaIdentifierFactory.validate(data)

        // Then
        expect(result).toBeLeftOf("quota_invalid_target_id")
      })
    })
  })

  describe("fromNodeAndMetric", () => {
    it("should create a valid identifier", () => {
      // Given
      const node = {type: "Org" as const, identifier: uuidv7()}
      const metric = "MAX_GROUPS"

      // When
      const result = QuotaIdentifierFactory.fromNodeAndQuota(node, metric)

      // Then
      expect(result).toBeRight()
    })
  })
})

describe("QuotaFactory", () => {
  const validNode = {type: "Org", identifier: uuidv7()}
  const validQuotaType = "MAX_GROUPS"
  const validId = uuidv7()
  const now = chance.date()

  describe("validate", () => {
    describe("good cases", () => {
      it("should validate a valid quota", () => {
        // Given
        const data = {
          id: validId,
          node: validNode,
          quotaType: validQuotaType,
          limit: 10,
          createdAt: now,
          updatedAt: now
        }

        // When
        const result = QuotaFactory.validate(data)

        // Then
        expect(result).toBeRight()
      })
    })

    describe("bad cases", () => {
      it("should fail if data is not an object", () => {
        // Given
        const data = null

        // When
        const result = QuotaFactory.validate(data)

        // Then
        expect(result).toBeLeftOf("quota_malformed_quota")
      })

      it("should fail if identifier validation fails", () => {
        // Given
        const data = {
          id: validId,
          node: {type: "User", identifier: uuidv7()},
          quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE",
          limit: 10,
          createdAt: now,
          updatedAt: now
        }

        // When
        const result = QuotaFactory.validate(data)

        // Then
        expect(result).toBeLeftOf("quota_malformed_quota")
      })

      it("should fail if id is invalid", () => {
        // Given
        const data = {
          id: "not-a-uuid",
          node: validNode,
          quotaType: validQuotaType,
          limit: 10,
          createdAt: now,
          updatedAt: now
        }

        // When
        const result = QuotaFactory.validate(data)

        // Then
        expect(result).toBeLeftOf("quota_invalid_id")
      })

      it("should fail if limit is invalid", () => {
        // Given
        const data1 = {
          id: validId,
          node: validNode,
          quotaType: validQuotaType,
          limit: -1,
          createdAt: now,
          updatedAt: now
        }
        const data2 = {...data1, limit: 1.5}

        // When
        const result1 = QuotaFactory.validate(data1)
        const result2 = QuotaFactory.validate(data2)

        // Then
        expect(result1).toBeLeftOf("quota_invalid_limit")
        expect(result2).toBeLeftOf("quota_invalid_limit")
      })

      it("should fail if dates are missing", () => {
        // Given
        const data = {
          id: validId,
          node: validNode,
          quotaType: validQuotaType,
          limit: 10
        }

        // When
        const result = QuotaFactory.validate(data)

        // Then
        expect(result).toBeLeftOf("quota_malformed_quota")
      })
    })
  })

  describe("newQuota", () => {
    it("should create a new quota with generated id and dates", () => {
      // Given
      const data = {
        node: validNode,
        quotaType: validQuotaType
      }
      const limit = 5

      // When
      const result = QuotaFactory.newQuota(data, limit)

      // Then
      expect(result).toBeRight()
    })
  })
})

describe("resolveEffectiveLimit", () => {
  it("should prioritize specific resource override over org override and tier baseline", () => {
    // Given
    const params = {
      metric: "MAX_WORKFLOW_TEMPLATES_PER_SPACE" as const,
      tier: "FREE" as const,
      specificResourceOverride: 25,
      orgOverride: 15
    }

    // When
    const res = resolveEffectiveLimit(params)

    // Expect
    expect(res).toBeRight()
    expect(unwrapRight(res)).toEqual({isUnlimited: false, limit: 25})
  })

  it("should prioritize org override over tier baseline when specific resource override is undefined", () => {
    // Given
    const params = {
      metric: "MAX_WORKFLOW_TEMPLATES_PER_SPACE" as const,
      tier: "FREE" as const,
      orgOverride: 15
    }

    // When
    const res = resolveEffectiveLimit(params)

    // Expect
    expect(res).toBeRight()
    expect(unwrapRight(res)).toEqual({isUnlimited: false, limit: 15})
  })

  it("should fallback to tier baseline default when no overrides are provided", () => {
    // Given
    const params = {
      metric: "MAX_WORKFLOW_TEMPLATES_PER_SPACE" as const,
      tier: "FREE" as const
    }

    // When
    const res = resolveEffectiveLimit(params)

    // Expect
    expect(res).toBeRight()
    expect(unwrapRight(res)).toEqual({isUnlimited: false, limit: 10})
  })

  it("should return explicit unlimited when effective limit is null in tier baseline", () => {
    // Given
    const params = {
      metric: "MAX_WORKFLOW_TEMPLATES_PER_SPACE" as const,
      tier: "SELF_HOSTED_UNLIMITED" as const
    }

    // When
    const res = resolveEffectiveLimit(params)

    // Expect
    expect(res).toBeRight()
    expect(unwrapRight(res)).toEqual({isUnlimited: true})
  })

  it("should return explicit unlimited when an override explicitly passes 'UNLIMITED'", () => {
    // Given
    const params = {
      metric: "MAX_WORKFLOW_TEMPLATES_PER_SPACE" as const,
      tier: "FREE" as const,
      specificResourceOverride: "UNLIMITED" as const
    }

    // When
    const res = resolveEffectiveLimit(params)

    // Expect
    expect(res).toBeRight()
    expect(unwrapRight(res)).toEqual({isUnlimited: true})
  })

  it("should fail closed returning quota_missing_configuration when quota metric/tier config is missing or invalid", () => {
    // Given
    const params = {
      metric: "UNKNOWN_METRIC" as unknown as SupportedQuotaType,
      tier: "FREE" as const
    }

    // When
    const res = resolveEffectiveLimit(params)

    // Expect
    expect(res).toBeLeftOf("quota_missing_configuration")
  })
})
