import {
  ApprovalRule,
  MembershipWithGroupRef,
  WorkflowTemplate,
  WorkflowTemplateFactory,
  SystemRole,
  BoundRole
} from "@domain"
import {createMembership, createGroupRequirementRule, createAndRule, createOrRule} from "./workflow-test-helpers"
import {randomUUID} from "crypto"
import {isRight} from "fp-ts/lib/Either"
import "@utils/matchers"

/**
 * Helper function to create a workflow template instance for testing.
 */
const getWorkflowTemplate = (rule: ApprovalRule): WorkflowTemplate => {
  const result = WorkflowTemplateFactory.newWorkflowTemplate({
    name: "Test Template",
    description: "A test template",
    approvalRule: rule,
    actions: []
  })

  if (!isRight(result)) {
    throw new Error(`Test setup failed: Unable to create workflow template. Error: ${result.left}`)
  }
  return result.right
}

/**
 * Helper function to create a voter role for a specific workflow template
 */
const createVoterRole = (workflowTemplateId: string): BoundRole<"workflow_template"> => {
  return SystemRole.createWorkflowTemplateVoterRole({
    type: "workflow_template",
    workflowTemplateId
  })
}

describe("WorkflowTemplate - canVote method", () => {
  const group1Id = randomUUID()
  const group2Id = randomUUID()
  const group3Id = randomUUID()
  const unrelatedGroupId = randomUUID()

  const membershipG1Approver = createMembership(group1Id, "user-1")
  const membershipG1Admin = createMembership(group1Id, "user-1")
  const membershipG1Owner = createMembership(group1Id, "user-1")
  const membershipG1Auditor = createMembership(group1Id, "user-1")
  const membershipG2Approver = createMembership(group2Id, "user-2")
  const membershipG3Approver = createMembership(group3Id, "user-3")
  const membershipUnrelatedApprover = createMembership(unrelatedGroupId, "user-4")

  describe("good cases", () => {
    it("should return true for GROUP_REQUIREMENT rule when user is in the required group with APPROVER role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in that group with APPROVER role
      const rule = createGroupRequirementRule(group1Id)
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG1Approver]
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      // When: canVote is called
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be true
      expect(result).toBeRightOf(true)
    })

    it("should return true for GROUP_REQUIREMENT rule when user is in the required group with ADMIN role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in that group with ADMIN role
      const rule = createGroupRequirementRule(group1Id)
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG1Admin]
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      // When: canVote is called
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be true
      expect(result).toBeRightOf(true)
    })

    it("should return true for GROUP_REQUIREMENT rule when user is in the required group with OWNER role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in that group with OWNER role
      const rule = createGroupRequirementRule(group1Id)
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG1Owner]
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      // When: canVote is called
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Right(true)
      expect(result).toBeRightOf(true)
    })

    it("should return true for GROUP_REQUIREMENT rule when user has multiple memberships including the required one with an allowed role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in that group among others, with an allowed role
      const rule = createGroupRequirementRule(group1Id)
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG2Approver, membershipG1Approver]
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Right(true)
      expect(result).toBeRightOf(true)
    })

    it("should return true for AND rule when user is in the first required group with an allowed role", () => {
      // Given: an AND rule and a user in the first group of the rule with an allowed role
      const rule = createAndRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG1Approver]
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Right(true)
      expect(result).toBeRightOf(true)
    })

    it("should return true for AND rule when user is in the second required group with an allowed role", () => {
      // Given: an AND rule and a user in the second group of the rule with an allowed role
      const rule = createAndRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG2Approver]
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Right(true)
      expect(result).toBeRightOf(true)
    })

    it("should return true for AND rule when user is in both required groups with allowed roles", () => {
      // Given: an AND rule and a user in both groups of the rule with allowed roles
      const rule = createAndRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG1Approver, membershipG2Approver]
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Right(true)
      expect(result).toBeRightOf(true)
    })

    it("should return true for OR rule when user is in the first required group with an allowed role", () => {
      // Given: an OR rule and a user in the first group of the rule with an allowed role
      const rule = createOrRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG1Approver]
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Right(true)
      expect(result).toBeRightOf(true)
    })

    it("should return true for OR rule when user is in the second required group with an allowed role", () => {
      // Given: an OR rule and a user in the second group of the rule with an allowed role
      const rule = createOrRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG2Approver]
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Right(true)
      expect(result).toBeRightOf(true)
    })

    it("should return true for OR rule when user is in both required groups with allowed roles", () => {
      // Given: an OR rule and a user in both groups of the rule with allowed roles
      const rule = createOrRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG1Approver, membershipG2Approver]
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Right(true)
      expect(result).toBeRightOf(true)
    })

    it("should return true for a nested AND/OR rule when user is in a group from the AND part with an allowed role", () => {
      // Given: a nested rule (G1 AND (G2 OR G3)) and user in G1 with an allowed role
      const rule = createAndRule([
        createGroupRequirementRule(group1Id),
        createOrRule([createGroupRequirementRule(group2Id), createGroupRequirementRule(group3Id)])
      ])
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG1Approver]
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Right(true)
      expect(result).toBeRightOf(true)
    })
  })

  describe("bad cases", () => {
    it("should return ENTITY_NOT_IN_REQUIRED_GROUP when user has no memberships", () => {
      // Given: a rule and a user with no memberships
      const rule = createGroupRequirementRule(group1Id)
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships: MembershipWithGroupRef[] = []
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Left(ENTITY_NOT_IN_REQUIRED_GROUP)
      expect(result).toBeLeftOf("entity_not_in_required_group")
    })

    it("should return ENTITY_NOT_IN_REQUIRED_GROUP for GROUP_REQUIREMENT rule when user is not in the required group", () => {
      // Given: a GROUP_REQUIREMENT rule and a user not in that group
      const rule = createGroupRequirementRule(group1Id)
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG2Approver] // User is in group2, rule requires group1
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Left(ENTITY_NOT_IN_REQUIRED_GROUP)
      expect(result).toBeLeftOf("entity_not_in_required_group")
    })

    it("should return entity_not_eligible_to_vote for GROUP_REQUIREMENT rule when user is in the required group but lacks voter role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in that group but without voter role
      const rule = createGroupRequirementRule(group1Id)
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG1Auditor]
      // When: canVote is called without voter roles
      const result = workflowTemplate.canVote(memberships, [])
      // Expect: the result to be Left(entity_not_eligible_to_vote)
      expect(result).toBeLeftOf("entity_not_eligible_to_vote")
    })

    it("should return ENTITY_NOT_IN_REQUIRED_GROUP for GROUP_REQUIREMENT rule when user has multiple memberships, none being the required one with an allowed role", () => {
      // Given: a GROUP_REQUIREMENT rule and a user in other groups with allowed roles
      const rule = createGroupRequirementRule(group1Id)
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipG2Approver, membershipG3Approver]
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Left(ENTITY_NOT_IN_REQUIRED_GROUP)
      expect(result).toBeLeftOf("entity_not_in_required_group")
    })

    it("should return ENTITY_NOT_IN_REQUIRED_GROUP for AND rule when user is in an unrelated group, even with an allowed role", () => {
      // Given: an AND rule and a user in an unrelated group with an allowed role
      const rule = createAndRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipUnrelatedApprover]
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Left(ENTITY_NOT_IN_REQUIRED_GROUP)
      expect(result).toBeLeftOf("entity_not_in_required_group")
    })

    it("should return ENTITY_NOT_IN_REQUIRED_GROUP for OR rule when user is in an unrelated group, even with an allowed role", () => {
      // Given: an OR rule and a user in an unrelated group with an allowed role
      const rule = createOrRule([createGroupRequirementRule(group1Id), createGroupRequirementRule(group2Id)])
      const workflowTemplate = getWorkflowTemplate(rule)
      const memberships = [membershipUnrelatedApprover]
      // When: canVote is called
      const voterRoles = [createVoterRole(workflowTemplate.id)]
      const result = workflowTemplate.canVote(memberships, voterRoles)
      // Expect: the result to be Left(ENTITY_NOT_IN_REQUIRED_GROUP)
      expect(result).toBeLeftOf("entity_not_in_required_group")
    })
  })
})
