import {ApprovalRule, ApprovalRuleFactory, ApprovalRuleType, ApprovalRuleValidationError} from "@domain"
import {unwrapLeft, unwrapRight} from "@utils/either"
import {randomUUID} from "crypto"
import {isLeft, isRight} from "fp-ts/lib/Either"

describe("ApprovalRuleFactory.validate", () => {
  describe("GROUP_REQUIREMENT", () => {
    it("validates a correct group requirement rule", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: 2}
      const result = ApprovalRuleFactory.validate(rule)
      expect(isRight(result)).toBe(true)
      expect(unwrapRight(result)).toEqual(rule)
    })
    it("fails if groupId is missing", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, minCount: 2}
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("group_rule_invalid_group_id")
    })
    it("fails if groupId is not a uuid", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: "not-a-uuid", minCount: 2}
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("group_rule_invalid_group_id")
    })
    it("fails if minCount is missing", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID()}
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("group_rule_invalid_min_count")
    })
    it("fails if minCount is not a number", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: "2"}
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("group_rule_invalid_min_count")
    })
    it("fails if minCount < 1", () => {
      const rule: ApprovalRule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: 0}
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("group_rule_invalid_min_count")
    })
  })

  describe("AND", () => {
    it("validates a correct AND rule", () => {
      const rule = {
        type: ApprovalRuleType.AND,
        rules: [
          {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: 1},
          {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: 2}
        ]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(isRight(result)).toBe(true)
      expect(unwrapRight(result)).toEqual(rule)
    })
    it("fails if rules is missing or empty", () => {
      const rule = {type: ApprovalRuleType.AND}
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("and_rule_must_have_rules")
      const rule2 = {type: ApprovalRuleType.AND, rules: []}
      const result2 = ApprovalRuleFactory.validate(rule2)
      expect(isLeft(result2)).toBe(true)
      expect(unwrapLeft(result2)).toBe<ApprovalRuleValidationError>("and_rule_must_have_rules")
    })
    it("fails if any nested rule is invalid", () => {
      const rule = {
        type: ApprovalRuleType.AND,
        rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: "not-a-uuid", minCount: 1}]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("group_rule_invalid_group_id")
    })
  })

  describe("OR", () => {
    it("validates a correct OR rule", () => {
      const rule = {
        type: ApprovalRuleType.OR,
        rules: [
          {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: 1},
          {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: 2}
        ]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(isRight(result)).toBe(true)
      expect(unwrapRight(result)).toEqual(rule)
    })
    it("fails if rules is missing or empty", () => {
      const rule = {type: ApprovalRuleType.OR}
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("or_rule_must_have_rules")
      const rule2 = {type: ApprovalRuleType.OR, rules: []}
      const result2 = ApprovalRuleFactory.validate(rule2)
      expect(isLeft(result2)).toBe(true)
      expect(unwrapLeft(result2)).toBe<ApprovalRuleValidationError>("or_rule_must_have_rules")
    })
    it("fails if any nested rule is invalid", () => {
      const rule = {
        type: ApprovalRuleType.OR,
        rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: "not-a-uuid", minCount: 1}]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("group_rule_invalid_group_id")
    })
  })

  describe("max nesting", () => {
    it("fails if AND is nested more than 2 levels", () => {
      const rule = {
        type: ApprovalRuleType.AND,
        rules: [
          {
            type: ApprovalRuleType.AND,
            rules: [
              {
                type: ApprovalRuleType.AND,
                rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: 1}]
              }
            ]
          }
        ]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("max_rule_nesting_exceeded")
    })
    it("fails if OR is nested more than 2 levels", () => {
      const rule = {
        type: ApprovalRuleType.OR,
        rules: [
          {
            type: ApprovalRuleType.OR,
            rules: [
              {
                type: ApprovalRuleType.OR,
                rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: 1}]
              }
            ]
          }
        ]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("max_rule_nesting_exceeded")
    })

    it("fails if AND and OR are mixed and exceed 2 levels", () => {
      const rule = {
        type: ApprovalRuleType.AND,
        rules: [
          {
            type: ApprovalRuleType.OR,
            rules: [
              {
                type: ApprovalRuleType.AND,
                rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: 1}]
              }
            ]
          }
        ]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("max_rule_nesting_exceeded")
    })

    it("allows 2 levels of nesting", () => {
      const rule = {
        type: ApprovalRuleType.AND,
        rules: [
          {
            type: ApprovalRuleType.OR,
            rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: 1}]
          }
        ]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(isRight(result)).toBe(true)
    })
  })

  describe("invalid type", () => {
    it("fails if type is not recognized", () => {
      const rule = {type: "NOT_A_TYPE", foo: 1}
      const result = ApprovalRuleFactory.validate(rule)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("invalid_rule_type")
    })
    it("fails if not an object", () => {
      const result = ApprovalRuleFactory.validate(null)
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<ApprovalRuleValidationError>("invalid_rule_type")
      const result2 = ApprovalRuleFactory.validate(42)
      expect(isLeft(result2)).toBe(true)
      expect(unwrapLeft(result2)).toBe<ApprovalRuleValidationError>("invalid_rule_type")
    })
  })
})
