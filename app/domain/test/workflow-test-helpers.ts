import {ApprovalRule, ApprovalRuleType, ApprovalRuleFactory} from "../src/approval-rules"
import {MembershipWithGroupRef} from "../src"
import {HumanGroupMembershipRole} from "../src/group-membership"
import * as E from "fp-ts/Either"

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
export const createGroupRequirementRule = (groupId: string, optionalMinCount?: number): ApprovalRule => {
  const minCount = optionalMinCount ?? 1

  const result = ApprovalRuleFactory.validate({
    type: ApprovalRuleType.GROUP_REQUIREMENT,
    groupId,
    minCount
  })
  if (E.isLeft(result)) throw new Error("Failed to create group requirement rule")
  return result.right
}

// Helper to create an AND rule
export const createAndRule = (rules: ApprovalRule[]): ApprovalRule => {
  const result = ApprovalRuleFactory.validate({
    type: ApprovalRuleType.AND,
    rules
  })
  if (E.isLeft(result)) throw new Error("Failed to create AND rule")
  return result.right
}

// Helper to create an OR rule
export const createOrRule = (rules: ApprovalRule[]): ApprovalRule => {
  const result = ApprovalRuleFactory.validate({
    type: ApprovalRuleType.OR,
    rules
  })
  if (E.isLeft(result)) throw new Error("Failed to create OR rule")
  return result.right
}
