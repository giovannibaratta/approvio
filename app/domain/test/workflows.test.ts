import {isRight} from "fp-ts/lib/Either"
import {ApprovalRule, MembershipWithGroupRef, HumanGroupMembershipRole, Workflow, WorkflowFactory} from "@domain"
import {createMembership, createGroupRequirementRule, createAndRule, createOrRule} from "./workflow-test-helpers"
import {randomUUID} from "crypto"

// Base parameters for creating a valid workflow for tests
const baseWorkflowParams = {
  name: "TestCanVoteWorkflow123",
  description: "A test workflow for the canVote method."
}

/**
 * Helper function to create a workflow instance for testing.
 */
const getWorkflow = (rule: ApprovalRule): Workflow => {
  const result = WorkflowFactory.newWorkflow({
    ...baseWorkflowParams,
    rule
  })

  if (!isRight(result)) {
    throw new Error(`Test setup failed: Unable to create workflow. Error: ${result.left}`)
  }
  return result.right
}

describe("Workflow - canVote method", () => {
  const group1Id = randomUUID()
  const group2Id = randomUUID()
  const group3Id = randomUUID()
  const unrelatedGroupId = randomUUID()

  const membershipG1Approver = createMembership(group1Id, "user-1", HumanGroupMembershipRole.APPROVER)
  const membershipG1Admin = createMembership(group1Id, "user-1", HumanGroupMembershipRole.ADMIN)
  const membershipG1Owner = createMembership(group1Id, "user-1", HumanGroupMembershipRole.OWNER)
  const membershipG1Auditor = createMembership(group1Id, "user-1", HumanGroupMembershipRole.AUDITOR)
  const membershipG2Approver = createMembership(group2Id, "user-2", HumanGroupMembershipRole.APPROVER)
  const membershipG3Approver = createMembership(group3Id, "user-3", HumanGroupMembershipRole.APPROVER)
  const membershipUnrelatedApprover = createMembership(unrelatedGroupId, "user-4", HumanGroupMembershipRole.APPROVER)

  describe("good cases", () => {
    it("should return true for GROUP_REQUIREMENT rule when user is in the required group with APPROVER role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in that group with APPROVER role
      const rule = createGroupRequirementRule(group1Id)
      const workflow = getWorkflow(rule)
      const memberships = [membershipG1Approver]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be true
      expect(result).toBe(true)
    })

    it("should return true for GROUP_REQUIREMENT rule when user is in the required group with ADMIN role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in that group with ADMIN role
      const rule = createGroupRequirementRule(group1Id)
      const workflow = getWorkflow(rule)
      const memberships = [membershipG1Admin]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be true
      expect(result).toBe(true)
    })

    it("should return true for GROUP_REQUIREMENT rule when user is in the required group with OWNER role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in that group with OWNER role
      const rule = createGroupRequirementRule(group1Id)
      const workflow = getWorkflow(rule)
      const memberships = [membershipG1Owner]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be true
      expect(result).toBe(true)
    })

    it("should return true for GROUP_REQUIREMENT rule when user has multiple memberships including the required one with an allowed role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in that group among others, with an allowed role
      const rule = createGroupRequirementRule(group1Id)
      const workflow = getWorkflow(rule)
      const memberships = [membershipG2Approver, membershipG1Approver]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be true
      expect(result).toBe(true)
    })

    it("should return true for AND rule when user is in the first required group with an allowed role", () => {
      // Given: an AND rule and a user in the first group of the rule with an allowed role
      const rule = createAndRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflow = getWorkflow(rule)
      const memberships = [membershipG1Approver]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be true
      expect(result).toBe(true)
    })

    it("should return true for AND rule when user is in the second required group with an allowed role", () => {
      // Given: an AND rule and a user in the second group of the rule with an allowed role
      const rule = createAndRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflow = getWorkflow(rule)
      const memberships = [membershipG2Approver]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be true
      expect(result).toBe(true)
    })

    it("should return true for AND rule when user is in both required groups with allowed roles", () => {
      // Given: an AND rule and a user in both groups of the rule with allowed roles
      const rule = createAndRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflow = getWorkflow(rule)
      const memberships = [membershipG1Approver, membershipG2Approver]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be true
      expect(result).toBe(true)
    })

    it("should return true for OR rule when user is in the first required group with an allowed role", () => {
      // Given: an OR rule and a user in the first group of the rule with an allowed role
      const rule = createOrRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflow = getWorkflow(rule)
      const memberships = [membershipG1Approver]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be true
      expect(result).toBe(true)
    })

    it("should return true for OR rule when user is in the second required group with an allowed role", () => {
      // Given: an OR rule and a user in the second group of the rule with an allowed role
      const rule = createOrRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflow = getWorkflow(rule)
      const memberships = [membershipG2Approver]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be true
      expect(result).toBe(true)
    })

    it("should return true for OR rule when user is in both required groups with allowed roles", () => {
      // Given: an OR rule and a user in both groups of the rule with allowed roles
      const rule = createOrRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflow = getWorkflow(rule)
      const memberships = [membershipG1Approver, membershipG2Approver]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be true
      expect(result).toBe(true)
    })

    it("should return true for a nested AND/OR rule when user is in a group from the AND part with an allowed role", () => {
      // Given: a nested rule (G1 AND (G2 OR G3)) and user in G1 with an allowed role
      const rule = createAndRule([
        createGroupRequirementRule(group1Id),
        createOrRule([createGroupRequirementRule(group2Id), createGroupRequirementRule(group3Id)])
      ])
      const workflow = getWorkflow(rule)
      const memberships = [membershipG1Approver]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be true
      expect(result).toBe(true)
    })
  })

  describe("bad cases", () => {
    it("should return false when user has no memberships", () => {
      // Given: a rule and a user with no memberships
      const rule = createGroupRequirementRule(group1Id)
      const workflow = getWorkflow(rule)
      const memberships: MembershipWithGroupRef[] = []
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be false
      expect(result).toBe(false)
    })

    it("should return false for GROUP_REQUIREMENT rule when user is not in the required group", () => {
      // Given: a GROUP_REQUIREMENT rule and a user not in that group
      const rule = createGroupRequirementRule(group1Id)
      const workflow = getWorkflow(rule)
      const memberships = [membershipG2Approver] // User is in group2, rule requires group1
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be false
      expect(result).toBe(false)
    })

    it("should return false for GROUP_REQUIREMENT rule when user is in the required group but with AUDITOR role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in that group but with AUDITOR role
      const rule = createGroupRequirementRule(group1Id)
      const workflow = getWorkflow(rule)
      const memberships = [membershipG1Auditor]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be false
      expect(result).toBe(false)
    })

    it("should return false for GROUP_REQUIREMENT rule when user has multiple memberships, none being the required one with an allowed role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in other groups with allowed roles
      const rule = createGroupRequirementRule(group1Id)
      const workflow = getWorkflow(rule)
      const memberships = [membershipG2Approver, membershipG3Approver]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be false
      expect(result).toBe(false)
    })

    it("should return false for AND rule when user is in an unrelated group, even with an allowed role", () => {
      // Given: an AND rule and a user in an unrelated group with an allowed role
      const rule = createAndRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflow = getWorkflow(rule)
      const memberships = [membershipUnrelatedApprover]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be false
      expect(result).toBe(false)
    })

    it("should return false for OR rule when user is in an unrelated group, even with an allowed role", () => {
      // Given: an OR rule and a user in an unrelated group with an allowed role
      const rule = createOrRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflow = getWorkflow(rule)
      const memberships = [membershipUnrelatedApprover]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be false
      expect(result).toBe(false)
    })

    it("should return false for a nested AND/OR rule when user is in an unrelated group, even with an allowed role", () => {
      // Given: a nested rule (G1 AND (G2 OR G3)) and user in an unrelated group with an allowed role
      const rule = createAndRule([
        createGroupRequirementRule(group1Id),
        createOrRule([createGroupRequirementRule(group2Id), createGroupRequirementRule(group3Id)])
      ])
      const workflow = getWorkflow(rule)
      const memberships = [membershipUnrelatedApprover]
      // When: canVote is called
      const result = workflow.canVote(memberships)
      // Expect: the result to be false
      expect(result).toBe(false)
    })
  })
})
