import {HumanGroupMembershipRole, MembershipFactory, MembershipValidationError} from "@domain"
import {randomUUID} from "crypto"

import {Either, isLeft, isRight} from "fp-ts/lib/Either"

// Helpers for unwrapping Either in tests
const unwrapRight = <L, R>(either: Either<L, R>): R => {
  if (isLeft(either)) throw new Error(`Failed to unwrap Either right. Either is left: ${either.left}`)
  return either.right
}

const unwrapLeft = <L, R>(either: Either<L, R>): L => {
  if (isRight(either)) throw new Error(`Failed to unwrap Either left: Either is right ${either.right}`)
  return either.left
}

describe("MembershipFactory", () => {
  describe("good cases", () => {
    it("should return right with a Membership object for valid user and role", () => {
      // Given
      const data = {user: randomUUID(), role: HumanGroupMembershipRole.ADMIN.toString()}

      // When
      const result = MembershipFactory.newMembership(data)

      // Expect
      expect(isRight(result)).toBe(true)
      const membership = unwrapRight(result)
      expect(membership.entity).toBe(data.user)
      expect(membership.role).toBe(HumanGroupMembershipRole.ADMIN)
      expect(membership.createdAt).toBeInstanceOf(Date)
      expect(membership.updatedAt).toBeInstanceOf(Date)
      expect(membership.getEntityId()).toBe(data.user)
    })
  })

  describe("bad cases", () => {
    it("should return left with 'invalid_uuid' for an invalid user string", () => {
      // Given
      const data = {user: "invalid-user-id", role: HumanGroupMembershipRole.ADMIN.toString()}

      // When
      const result = MembershipFactory.newMembership(data)

      // Expect
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<MembershipValidationError>("invalid_uuid")
    })

    it("should return left with 'invalid_role' for an invalid role string", () => {
      // Given
      const data = {user: randomUUID(), role: "invalid_role_string"}

      // When
      const result = MembershipFactory.newMembership(data)

      // Expect
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<MembershipValidationError>("invalid_role")
    })
  })
})
