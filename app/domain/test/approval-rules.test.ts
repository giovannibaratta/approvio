import {
  ApprovalRuleData,
  ApprovalRuleFactory,
  ApprovalRuleType,
  ApproveVote,
  doesVotesCoverApprovalRules
} from "@domain"
import {unwrapRight} from "@utils/either"
import {randomUUID} from "crypto"
import "@utils/matchers"
import {createAndRule, createGroupRequirementRule, createOrRule} from "./workflow-test-helpers"

describe("ApprovalRuleFactory.validate", () => {
  describe("GROUP_REQUIREMENT", () => {
    it("validates a correct group requirement rule", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: 2}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeRight()
    })

    it("fails if groupId is missing", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, minCount: 2}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("group_rule_invalid_group_id")
    })

    it("fails if groupId is not a uuid", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: "not-a-uuid", minCount: 2}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("group_rule_invalid_group_id")
    })

    it("fails if minCount is missing", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID()}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("group_rule_invalid_min_count")
    })

    it("fails if minCount is not a number", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: randomUUID(), minCount: "2"}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("group_rule_invalid_min_count")
    })

    it("fails if minCount < 1", () => {
      const rule = {
        type: ApprovalRuleType.GROUP_REQUIREMENT,
        groupId: randomUUID(),
        minCount: 0
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("group_rule_invalid_min_count")
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
      expect(result).toBeRight()
      expect(unwrapRight(result)).toMatchObject(rule)
    })
    it("fails if rules is missing or empty", () => {
      const rule = {type: ApprovalRuleType.AND}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("and_rule_must_have_rules")
      const rule2 = {type: ApprovalRuleType.AND, rules: []}
      const result2 = ApprovalRuleFactory.validate(rule2)
      expect(result2).toBeLeftOf("and_rule_must_have_rules")
    })
    it("fails if any nested rule is invalid", () => {
      const rule = {
        type: ApprovalRuleType.AND,
        rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: "not-a-uuid", minCount: 1}]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("group_rule_invalid_group_id")
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
      expect(result).toBeRight()
      expect(unwrapRight(result)).toMatchObject(rule)
    })
    it("fails if rules is missing or empty", () => {
      const rule = {type: ApprovalRuleType.OR}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("or_rule_must_have_rules")
      const rule2 = {type: ApprovalRuleType.OR, rules: []}
      const result2 = ApprovalRuleFactory.validate(rule2)
      expect(result2).toBeLeftOf("or_rule_must_have_rules")
    })
    it("fails if any nested rule is invalid", () => {
      const rule = {
        type: ApprovalRuleType.OR,
        rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: "not-a-uuid", minCount: 1}]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("group_rule_invalid_group_id")
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
      expect(result).toBeLeftOf("max_rule_nesting_exceeded")
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
      expect(result).toBeLeftOf("max_rule_nesting_exceeded")
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
      expect(result).toBeLeftOf("max_rule_nesting_exceeded")
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
      expect(result).toBeRight()
    })
  })

  describe("invalid type", () => {
    it("fails if type is not recognized", () => {
      const rule = {type: "NOT_A_TYPE", foo: 1}
      const result = ApprovalRuleFactory.validate(rule)

      expect(result).toBeLeftOf("invalid_rule_type")
    })
    it("fails if not an object", () => {
      const result = ApprovalRuleFactory.validate(null)

      expect(result).toBeLeftOf("invalid_rule_type")
      const result2 = ApprovalRuleFactory.validate(42)
      expect(result2).toBeLeftOf("invalid_rule_type")
    })
  })
})

describe("doesVotesCoverApprovalRules", () => {
  const createApproveVote = (votedForGroups: string[], userId?: string): ApproveVote => ({
    id: randomUUID(),
    workflowId: randomUUID(),
    userId: userId || randomUUID(),
    type: "APPROVE",
    votedForGroups,
    castedAt: new Date()
  })

  describe("GROUP_REQUIREMENT rule", () => {
    describe("good cases", () => {
      it("returns true when single user vote satisfies minCount of 1", () => {
        // Given: a group requirement rule with minCount 1 and one user vote for that group
        const groupId = randomUUID()
        const userId = randomUUID()
        const rule = createGroupRequirementRule(groupId, 1)
        const votes = [createApproveVote([groupId], userId)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule to be satisfied
        expect(result).toBe(true)
      })

      it("returns true when vote includes the required group among others", () => {
        // Given: a group requirement rule and a vote for multiple groups including the required one
        const groupId = randomUUID()
        const otherGroupId = randomUUID()
        const userId = randomUUID()
        const rule = createGroupRequirementRule(groupId, 1)
        const votes = [createApproveVote([otherGroupId, groupId], userId)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule to be satisfied
        expect(result).toBe(true)
      })

      it("returns true when multiple different users satisfy minCount requirement", () => {
        // Given: a group requirement rule with minCount 2 and votes from 2 different users
        const groupId = randomUUID()
        const userId1 = randomUUID()
        const userId2 = randomUUID()
        const rule = createGroupRequirementRule(groupId, 2)
        const votes = [createApproveVote([groupId], userId1), createApproveVote([groupId], userId2)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule to be satisfied
        expect(result).toBe(true)
      })

      it("returns true when more users than required vote for the group", () => {
        // Given: a group requirement rule with minCount 2 and votes from 3 different users
        const groupId = randomUUID()
        const userId1 = randomUUID()
        const userId2 = randomUUID()
        const userId3 = randomUUID()
        const rule = createGroupRequirementRule(groupId, 2)
        const votes = [
          createApproveVote([groupId], userId1),
          createApproveVote([groupId], userId2),
          createApproveVote([groupId], userId3)
        ]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule to be satisfied
        expect(result).toBe(true)
      })

      it("returns true when same user votes multiple times but only counts once", () => {
        // Given: a group requirement rule with minCount 1 and multiple votes from same user
        const groupId = randomUUID()
        const userId = randomUUID()
        const rule = createGroupRequirementRule(groupId, 1)
        const votes = [
          createApproveVote([groupId], userId),
          createApproveVote([groupId], userId) // Same user voting again
        ]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule to be satisfied (user counted only once)
        expect(result).toBe(true)
      })
    })

    describe("bad cases", () => {
      it("returns false when no votes exist", () => {
        // Given: a group requirement rule and no votes
        const groupId = randomUUID()
        const rule = createGroupRequirementRule(groupId, 1)
        const votes: ApproveVote[] = []

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule not to be satisfied
        expect(result).toBe(false)
      })

      it("returns false when vote does not include the required group", () => {
        // Given: a group requirement rule and a vote for a different group
        const groupId = randomUUID()
        const otherGroupId = randomUUID()
        const userId = randomUUID()
        const rule: ApprovalRuleData = {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId,
          minCount: 1
        }
        const votes = [createApproveVote([otherGroupId], userId)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule not to be satisfied
        expect(result).toBe(false)
      })

      it("returns false when not enough unique users vote for the group", () => {
        // Given: a group requirement rule with minCount 3 and votes from only 2 users
        const groupId = randomUUID()
        const userId1 = randomUUID()
        const userId2 = randomUUID()
        const rule: ApprovalRuleData = {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId,
          minCount: 3
        }
        const votes = [createApproveVote([groupId], userId1), createApproveVote([groupId], userId2)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule not to be satisfied
        expect(result).toBe(false)
      })

      it("returns false when same user votes multiple times but minCount requires more users", () => {
        // Given: a group requirement rule with minCount 2 and multiple votes from same user
        const groupId = randomUUID()
        const userId = randomUUID()
        const rule: ApprovalRuleData = {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId,
          minCount: 2
        }
        const votes = [
          createApproveVote([groupId], userId),
          createApproveVote([groupId], userId), // Same user voting again
          createApproveVote([groupId], userId) // Same user voting yet again
        ]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule not to be satisfied (only 1 unique user)
        expect(result).toBe(false)
      })
    })
  })

  describe("AND rule", () => {
    describe("good cases", () => {
      it("returns true when all nested rules are satisfied", () => {
        // Given: an AND rule with two group requirements and votes that satisfy both
        const groupId1 = randomUUID()
        const groupId2 = randomUUID()
        const userId = randomUUID()
        const rule = createAndRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId1, groupId2], userId)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule to be satisfied
        expect(result).toBe(true)
      })

      it("returns true when all nested rules are satisfied by different votes", () => {
        // Given: an AND rule with two group requirements and separate votes for each group
        const groupId1 = randomUUID()
        const groupId2 = randomUUID()
        const userId1 = randomUUID()
        const userId2 = randomUUID()
        const rule = createAndRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId1], userId1), createApproveVote([groupId2], userId2)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule to be satisfied
        expect(result).toBe(true)
      })
    })

    describe("bad cases", () => {
      it("returns false when only some nested rules are satisfied", () => {
        // Given: an AND rule with two group requirements and votes that satisfy only one
        const groupId1 = randomUUID()
        const groupId2 = randomUUID()
        const userId = randomUUID()
        const rule = createAndRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId1], userId)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule not to be satisfied
        expect(result).toBe(false)
      })

      it("returns false when no nested rules are satisfied", () => {
        // Given: an AND rule with two group requirements and no relevant votes
        const groupId1 = randomUUID()
        const groupId2 = randomUUID()
        const otherGroupId = randomUUID()
        const userId = randomUUID()
        const rule = createAndRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([otherGroupId], userId)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule not to be satisfied
        expect(result).toBe(false)
      })
    })
  })

  describe("OR rule", () => {
    describe("good cases", () => {
      it("returns true when one nested rule is satisfied", () => {
        // Given: an OR rule with two group requirements and votes that satisfy one
        const groupId1 = randomUUID()
        const groupId2 = randomUUID()
        const userId = randomUUID()
        const rule = createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId1], userId)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule to be satisfied
        expect(result).toBe(true)
      })

      it("returns true when all nested rules are satisfied", () => {
        // Given: an OR rule with two group requirements and votes that satisfy both
        const groupId1 = randomUUID()
        const groupId2 = randomUUID()
        const userId = randomUUID()
        const rule = createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId1, groupId2], userId)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule to be satisfied
        expect(result).toBe(true)
      })

      it("returns true when the second nested rule is satisfied", () => {
        // Given: an OR rule with two group requirements and votes that satisfy the second one
        const groupId1 = randomUUID()
        const groupId2 = randomUUID()
        const userId = randomUUID()
        const rule = createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId2], userId)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule to be satisfied
        expect(result).toBe(true)
      })
    })

    describe("bad cases", () => {
      it("returns false when no nested rules are satisfied", () => {
        // Given: an OR rule with two group requirements and no relevant votes
        const groupId1 = randomUUID()
        const groupId2 = randomUUID()
        const otherGroupId = randomUUID()
        const userId = randomUUID()
        const rule = createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([otherGroupId], userId)]

        // When: checking if votes cover the approval rule
        const result = doesVotesCoverApprovalRules(rule, votes)

        // Expect: the rule not to be satisfied
        expect(result).toBe(false)
      })
    })
  })

  describe("complex nested rules", () => {
    it("handles nested AND within OR correctly", () => {
      // Given: an OR rule containing an AND rule and a simple group requirement
      const groupId1 = randomUUID()
      const groupId2 = randomUUID()
      const groupId3 = randomUUID()
      const userId = randomUUID()
      const rule = createOrRule([
        createAndRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)]),
        createGroupRequirementRule(groupId3, 1)
      ])
      const votes = [createApproveVote([groupId3], userId)]

      // When: checking if votes cover the approval rule
      const result = doesVotesCoverApprovalRules(rule, votes)

      // Expect: the rule to be satisfied (OR satisfied by the simple group requirement)
      expect(result).toBe(true)
    })

    it("handles nested OR within AND correctly", () => {
      // Given: an AND rule containing an OR rule and a simple group requirement
      const groupId1 = randomUUID()
      const groupId2 = randomUUID()
      const groupId3 = randomUUID()
      const userId = randomUUID()
      const rule = createAndRule([
        createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)]),
        createGroupRequirementRule(groupId3, 1)
      ])
      const votes = [createApproveVote([groupId1, groupId3], userId)]

      // When: checking if votes cover the approval rule
      const result = doesVotesCoverApprovalRules(rule, votes)

      // Expect: the rule to be satisfied (both OR and group requirement satisfied)
      expect(result).toBe(true)
    })

    it("returns false for complex nested rules when not all conditions are met", () => {
      // Given: an AND rule containing an OR rule and a simple group requirement
      const groupId1 = randomUUID()
      const groupId2 = randomUUID()
      const groupId3 = randomUUID()
      const userId = randomUUID()
      const rule = createAndRule([
        createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)]),
        createGroupRequirementRule(groupId3, 1)
      ])
      const votes = [createApproveVote([groupId1], userId)] // Missing groupId3

      // When: checking if votes cover the approval rule
      const result = doesVotesCoverApprovalRules(rule, votes)

      // Expect: the rule not to be satisfied (AND requires both conditions)
      expect(result).toBe(false)
    })

    it("handles complex minCount requirements with multiple users", () => {
      // Given: an AND rule where one group needs 2 users and another needs 1 user
      const groupId1 = randomUUID()
      const groupId2 = randomUUID()
      const userId1 = randomUUID()
      const userId2 = randomUUID()
      const userId3 = randomUUID()
      const rule = createAndRule([createGroupRequirementRule(groupId1, 2), createGroupRequirementRule(groupId2, 1)])
      const votes = [
        createApproveVote([groupId1], userId1),
        createApproveVote([groupId1], userId2),
        createApproveVote([groupId2], userId3)
      ]

      // When: checking if votes cover the approval rule
      const result = doesVotesCoverApprovalRules(rule, votes)

      // Expect: the rule to be satisfied (2 users for group1, 1 user for group2)
      expect(result).toBe(true)
    })

    it("fails when minCount requirement not met in complex nested structure", () => {
      // Given: an AND rule where one group needs 3 users but only 2 vote
      const groupId1 = randomUUID()
      const groupId2 = randomUUID()
      const userId1 = randomUUID()
      const userId2 = randomUUID()
      const userId3 = randomUUID()
      const rule = createAndRule([createGroupRequirementRule(groupId1, 3), createGroupRequirementRule(groupId2, 1)])
      const votes = [
        createApproveVote([groupId1], userId1),
        createApproveVote([groupId1], userId2), // Only 2 users for group1, need 3
        createApproveVote([groupId2], userId3)
      ]

      // When: checking if votes cover the approval rule
      const result = doesVotesCoverApprovalRules(rule, votes)

      // Expect: the rule not to be satisfied (insufficient users for group1)
      expect(result).toBe(false)
    })
  })
})
