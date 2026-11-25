import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {ApprovalRule, ApprovalRuleType, ApprovalRuleFactory, OrgRole, User, createUserMembershipEntity} from "@domain"
import {MembershipWithGroupRef} from "../src"
import * as E from "fp-ts/Either"
import {v7 as uuidv7} from "uuid"
import {createTestUser as createTenantUser} from "../../test/user"
import {unwrapRight} from "@utils/either"

// Helper to create a test user
const createTestUser = (organizationId: string, userId = "test-user"): User => {
  const user = unwrapRight(
    createTenantUser({
      organizationId,
      accountId: uuidv7(),
      displayName: "Test User",
      orgRole: OrgRole.MEMBER
    })
  )
  // For test purposes, we'll override the ID after validation.
  return {
    ...user,
    id: userId
  }
}

// Helper to create MembershipWithGroupRef
export const createMembership = (
  groupId: string,
  overrides?: {organizationId?: string; userId?: string}
): MembershipWithGroupRef => {
  const organizationId =
    overrides?.organizationId === undefined ? randomOrgId() : toOrganizationId(overrides.organizationId)
  const userId = overrides?.userId ?? "test-user"
  return {
    organizationId,
    entity: createUserMembershipEntity(createTestUser(organizationId, userId)),
    groupId,
    createdAt: new Date(),
    updatedAt: new Date(),
    getEntityId: () => userId,
    getEntityType: () => "user"
  }
}

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
