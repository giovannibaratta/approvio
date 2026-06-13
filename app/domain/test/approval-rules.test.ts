import {
  ApprovalRuleData,
  ApprovalRuleFactory,
  ApprovalRuleType,
  ApproveVote,
  doesVotesCoverApprovalRules,
  getNormalizedEntityId
} from "@domain"
import {unwrapRight} from "@utils/either"

import "@utils/matchers"
import {createAndRule, createGroupRequirementRule, createOrRule} from "./workflow-test-helpers"
import {v7 as uuidv7} from "uuid"

describe("ApprovalRuleFactory.validate", () => {
  describe("GROUP_REQUIREMENT", () => {
    it("validates a correct group requirement rule", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7(), minCount: 2}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeRight()
    })

    it("fails if groupId is missing", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, minCount: 2}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_group_rule_invalid_group_id")
    })

    it("fails if groupId is not a uuid", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: "not-a-uuid", minCount: 2}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_group_rule_invalid_group_id")
    })

    it("fails if minCount is missing", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7()}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_group_rule_invalid_min_count")
    })

    it("fails if minCount is not a number", () => {
      const rule = {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7(), minCount: "2"}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_group_rule_invalid_min_count")
    })

    it("fails if minCount < 1", () => {
      const rule = {
        type: ApprovalRuleType.GROUP_REQUIREMENT,
        groupId: uuidv7(),
        minCount: 0
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_group_rule_invalid_min_count")
    })
  })

  describe("AND", () => {
    it("validates a correct AND rule", () => {
      const rule = {
        type: ApprovalRuleType.AND,
        rules: [
          {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7(), minCount: 1},
          {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7(), minCount: 2}
        ]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeRight()
      expect(unwrapRight(result)).toMatchObject(rule)
    })
    it("fails if rules is missing or empty", () => {
      const rule = {type: ApprovalRuleType.AND}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_and_rule_must_have_rules")
      const rule2 = {type: ApprovalRuleType.AND, rules: []}
      const result2 = ApprovalRuleFactory.validate(rule2)
      expect(result2).toBeLeftOf("approval_rule_and_rule_must_have_rules")
    })
    it("fails if any nested rule is invalid", () => {
      const rule = {
        type: ApprovalRuleType.AND,
        rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: "not-a-uuid", minCount: 1}]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_group_rule_invalid_group_id")
    })
  })

  describe("OR", () => {
    it("validates a correct OR rule", () => {
      const rule = {
        type: ApprovalRuleType.OR,
        rules: [
          {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7(), minCount: 1},
          {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7(), minCount: 2}
        ]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeRight()
      expect(unwrapRight(result)).toMatchObject(rule)
    })
    it("fails if rules is missing or empty", () => {
      const rule = {type: ApprovalRuleType.OR}
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_or_rule_must_have_rules")
      const rule2 = {type: ApprovalRuleType.OR, rules: []}
      const result2 = ApprovalRuleFactory.validate(rule2)
      expect(result2).toBeLeftOf("approval_rule_or_rule_must_have_rules")
    })
    it("fails if any nested rule is invalid", () => {
      const rule = {
        type: ApprovalRuleType.OR,
        rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: "not-a-uuid", minCount: 1}]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_group_rule_invalid_group_id")
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
                rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7(), minCount: 1}]
              }
            ]
          }
        ]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_max_rule_nesting_exceeded")
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
                rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7(), minCount: 1}]
              }
            ]
          }
        ]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_max_rule_nesting_exceeded")
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
                rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7(), minCount: 1}]
              }
            ]
          }
        ]
      }
      const result = ApprovalRuleFactory.validate(rule)
      expect(result).toBeLeftOf("approval_rule_max_rule_nesting_exceeded")
    })

    it("allows 2 levels of nesting", () => {
      const rule = {
        type: ApprovalRuleType.AND,
        rules: [
          {
            type: ApprovalRuleType.OR,
            rules: [{type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7(), minCount: 1}]
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

      expect(result).toBeLeftOf("approval_rule_invalid_rule_type")
    })
    it("fails if not an object", () => {
      const result = ApprovalRuleFactory.validate(null)

      expect(result).toBeLeftOf("approval_rule_invalid_rule_type")
      const result2 = ApprovalRuleFactory.validate(42)
      expect(result2).toBeLeftOf("approval_rule_invalid_rule_type")
    })
  })
})

describe("doesVotesCoverApprovalRules", () => {
  const createApproveVote = (votedForGroups: string[], userId?: string): ApproveVote => ({
    id: uuidv7(),
    workflowId: uuidv7(),
    voter: {
      entityId: userId || uuidv7(),
      entityType: "user"
    },
    type: "APPROVE",
    votedForGroups,
    castedAt: new Date()
  })

  const toGroupVotersMap = (votes: ApproveVote[]): Map<string, Set<string>> => {
    const groupVoters = new Map<string, Set<string>>()
    for (const vote of votes)
      for (const groupId of vote.votedForGroups) {
        if (!groupVoters.has(groupId)) groupVoters.set(groupId, new Set())
        groupVoters.get(groupId)!.add(getNormalizedEntityId(vote.voter))
      }

    return groupVoters
  }

  describe("GROUP_REQUIREMENT rule", () => {
    describe("good cases", () => {
      it("returns true when single user vote satisfies minCount of 1", () => {
        // Given
        const groupId = uuidv7()
        const userId = uuidv7()
        const rule = createGroupRequirementRule(groupId, 1)
        const votes = [createApproveVote([groupId], userId)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(true)
      })

      it("returns true when vote includes the required group among others", () => {
        // Given
        const groupId = uuidv7()
        const otherGroupId = uuidv7()
        const userId = uuidv7()
        const rule = createGroupRequirementRule(groupId, 1)
        const votes = [createApproveVote([otherGroupId, groupId], userId)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(true)
      })

      it("returns true when multiple different users satisfy minCount requirement", () => {
        // Given
        const groupId = uuidv7()
        const userId1 = uuidv7()
        const userId2 = uuidv7()
        const rule = createGroupRequirementRule(groupId, 2)
        const votes = [createApproveVote([groupId], userId1), createApproveVote([groupId], userId2)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(true)
      })

      it("returns true when more users than required vote for the group", () => {
        // Given
        const groupId = uuidv7()
        const userId1 = uuidv7()
        const userId2 = uuidv7()
        const userId3 = uuidv7()
        const rule = createGroupRequirementRule(groupId, 2)
        const votes = [
          createApproveVote([groupId], userId1),
          createApproveVote([groupId], userId2),
          createApproveVote([groupId], userId3)
        ]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(true)
      })

      it("returns true when same user votes multiple times but only counts once", () => {
        // Given
        const groupId = uuidv7()
        const userId = uuidv7()
        const rule = createGroupRequirementRule(groupId, 1)
        const votes = [createApproveVote([groupId], userId), createApproveVote([groupId], userId)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(true)
      })
    })

    describe("bad cases", () => {
      it("returns false when no votes exist", () => {
        // Given
        const groupId = uuidv7()
        const rule = createGroupRequirementRule(groupId, 1)
        const votes: ApproveVote[] = []
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(false)
      })

      it("returns false when vote does not include the required group", () => {
        // Given
        const groupId = uuidv7()
        const otherGroupId = uuidv7()
        const userId = uuidv7()
        const rule: ApprovalRuleData = {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId,
          minCount: 1
        }
        const votes = [createApproveVote([otherGroupId], userId)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(false)
      })

      it("returns false when not enough unique users vote for the group", () => {
        // Given
        const groupId = uuidv7()
        const userId1 = uuidv7()
        const userId2 = uuidv7()
        const rule: ApprovalRuleData = {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId,
          minCount: 3
        }
        const votes = [createApproveVote([groupId], userId1), createApproveVote([groupId], userId2)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(false)
      })

      it("returns false when same user votes multiple times but minCount requires more users", () => {
        // Given
        const groupId = uuidv7()
        const userId = uuidv7()
        const rule: ApprovalRuleData = {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId,
          minCount: 2
        }
        const votes = [
          createApproveVote([groupId], userId),
          createApproveVote([groupId], userId),
          createApproveVote([groupId], userId)
        ]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(false)
      })
    })
  })

  describe("AND rule", () => {
    describe("good cases", () => {
      it("returns true when all nested rules are satisfied", () => {
        // Given
        const groupId1 = uuidv7()
        const groupId2 = uuidv7()
        const userId = uuidv7()
        const rule = createAndRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId1, groupId2], userId)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(true)
      })

      it("returns true when all nested rules are satisfied by different votes", () => {
        // Given
        const groupId1 = uuidv7()
        const groupId2 = uuidv7()
        const userId1 = uuidv7()
        const userId2 = uuidv7()
        const rule = createAndRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId1], userId1), createApproveVote([groupId2], userId2)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(true)
      })
    })

    describe("bad cases", () => {
      it("returns false when only some nested rules are satisfied", () => {
        // Given
        const groupId1 = uuidv7()
        const groupId2 = uuidv7()
        const userId = uuidv7()
        const rule = createAndRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId1], userId)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(false)
      })

      it("returns false when no nested rules are satisfied", () => {
        // Given
        const groupId1 = uuidv7()
        const groupId2 = uuidv7()
        const otherGroupId = uuidv7()
        const userId = uuidv7()
        const rule = createAndRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([otherGroupId], userId)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(false)
      })
    })
  })

  describe("OR rule", () => {
    describe("good cases", () => {
      it("returns true when one nested rule is satisfied", () => {
        // Given
        const groupId1 = uuidv7()
        const groupId2 = uuidv7()
        const userId = uuidv7()
        const rule = createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId1], userId)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(true)
      })

      it("returns true when all nested rules are satisfied", () => {
        // Given
        const groupId1 = uuidv7()
        const groupId2 = uuidv7()
        const userId = uuidv7()
        const rule = createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId1, groupId2], userId)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(true)
      })

      it("returns true when the second nested rule is satisfied", () => {
        // Given
        const groupId1 = uuidv7()
        const groupId2 = uuidv7()
        const userId = uuidv7()
        const rule = createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([groupId2], userId)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(true)
      })
    })

    describe("bad cases", () => {
      it("returns false when no nested rules are satisfied", () => {
        // Given
        const groupId1 = uuidv7()
        const groupId2 = uuidv7()
        const otherGroupId = uuidv7()
        const userId = uuidv7()
        const rule = createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)])
        const votes = [createApproveVote([otherGroupId], userId)]
        const groupVoters = toGroupVotersMap(votes)

        // When
        const result = doesVotesCoverApprovalRules(rule, groupVoters)

        // Expect
        expect(result).toBe(false)
      })
    })
  })

  describe("complex nested rules", () => {
    it("handles nested AND within OR correctly", () => {
      // Given
      const groupId1 = uuidv7()
      const groupId2 = uuidv7()
      const groupId3 = uuidv7()
      const userId = uuidv7()
      const rule = createOrRule([
        createAndRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)]),
        createGroupRequirementRule(groupId3, 1)
      ])
      const votes = [createApproveVote([groupId3], userId)]
      const groupVoters = toGroupVotersMap(votes)

      // When
      const result = doesVotesCoverApprovalRules(rule, groupVoters)

      // Expect
      expect(result).toBe(true)
    })

    it("handles nested OR within AND correctly", () => {
      // Given
      const groupId1 = uuidv7()
      const groupId2 = uuidv7()
      const groupId3 = uuidv7()
      const userId = uuidv7()
      const rule = createAndRule([
        createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)]),
        createGroupRequirementRule(groupId3, 1)
      ])
      const votes = [createApproveVote([groupId1, groupId3], userId)]
      const groupVoters = toGroupVotersMap(votes)

      // When
      const result = doesVotesCoverApprovalRules(rule, groupVoters)

      // Expect
      expect(result).toBe(true)
    })

    it("returns false for complex nested rules when not all conditions are met", () => {
      // Given
      const groupId1 = uuidv7()
      const groupId2 = uuidv7()
      const groupId3 = uuidv7()
      const userId = uuidv7()
      const rule = createAndRule([
        createOrRule([createGroupRequirementRule(groupId1, 1), createGroupRequirementRule(groupId2, 1)]),
        createGroupRequirementRule(groupId3, 1)
      ])
      const votes = [createApproveVote([groupId1], userId)]
      const groupVoters = toGroupVotersMap(votes)

      // When
      const result = doesVotesCoverApprovalRules(rule, groupVoters)

      // Expect
      expect(result).toBe(false)
    })

    it("handles complex minCount requirements with multiple users", () => {
      // Given
      const groupId1 = uuidv7()
      const groupId2 = uuidv7()
      const userId1 = uuidv7()
      const userId2 = uuidv7()
      const userId3 = uuidv7()
      const rule = createAndRule([createGroupRequirementRule(groupId1, 2), createGroupRequirementRule(groupId2, 1)])
      const votes = [
        createApproveVote([groupId1], userId1),
        createApproveVote([groupId1], userId2),
        createApproveVote([groupId2], userId3)
      ]
      const groupVoters = toGroupVotersMap(votes)

      // When
      const result = doesVotesCoverApprovalRules(rule, groupVoters)

      // Expect
      expect(result).toBe(true)
    })

    it("fails when minCount requirement not met in complex nested structure", () => {
      // Given
      const groupId1 = uuidv7()
      const groupId2 = uuidv7()
      const userId1 = uuidv7()
      const userId2 = uuidv7()
      const userId3 = uuidv7()
      const rule = createAndRule([createGroupRequirementRule(groupId1, 3), createGroupRequirementRule(groupId2, 1)])
      const votes = [
        createApproveVote([groupId1], userId1),
        createApproveVote([groupId1], userId2),
        createApproveVote([groupId2], userId3)
      ]
      const groupVoters = toGroupVotersMap(votes)

      // When
      const result = doesVotesCoverApprovalRules(rule, groupVoters)

      // Expect
      expect(result).toBe(false)
    })
  })
})
