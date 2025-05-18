import {ApprovalRule, ApprovalRuleType} from "../src/approval-rules"
import {MembershipWithGroupRef} from "../src"
import {HumanGroupMembershipRole} from "../src/group-membership"

// Helper to create MembershipWithGroupRef
export const createMembership = (
  groupId: string,
  userId = "test-user",
  role = HumanGroupMembershipRole.APPROVER
): MembershipWithGroupRef => ({
  entity: userId,
  groupId,
  role,
  createdAt: new Date(),
  updatedAt: new Date(),
  getEntityId: () => {
    throw new Error("Not implemented")
  }
})

// Helper to create a GROUP_REQUIREMENT rule
export const createGroupRequirementRule = (groupId: string): ApprovalRule => ({
  type: ApprovalRuleType.GROUP_REQUIREMENT,
  groupId,
  minCount: 1
})

// Helper to create an AND rule
export const createAndRule = (rules: ApprovalRule[]): ApprovalRule => ({
  type: ApprovalRuleType.AND,
  rules
})

// Helper to create an OR rule
export const createOrRule = (rules: ApprovalRule[]): ApprovalRule => ({
  type: ApprovalRuleType.OR,
  rules
})
