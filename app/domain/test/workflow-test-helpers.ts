import {ApprovalRule, ApprovalRuleType, ApprovalRuleFactory, User, UserFactory} from "../src"
import {MembershipWithGroupRef} from "../src"
import * as E from "fp-ts/Either"

// Helper to create a test user
const createTestUser = (userId = "test-user"): User => {
  const result = UserFactory.newUser({
    displayName: "Test User",
    email: "test@example.com",
    orgRole: "member"
  })
  if (E.isLeft(result)) throw new Error("Failed to create test user")

  // For test purposes, we'll override the ID after validation
  const user = result.right
  return {
    ...user,
    id: userId
  }
}

// Helper to create MembershipWithGroupRef
export const createMembership = (groupId: string, userId = "test-user"): MembershipWithGroupRef => ({
  entity: createTestUser(userId),
  groupId,
  createdAt: new Date(),
  updatedAt: new Date(),
  getEntityId: () => userId,
  getEntityType: () => "user"
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
