import {MembershipStatus, OrgRole, User, UserFactory, UserValidationError} from "@domain"
import {Either} from "fp-ts/Either"
import {v7 as uuidv7} from "uuid"

export function createTestUser(input: {
  readonly organizationId: string
  readonly accountId: string
  readonly displayName: string
  readonly orgRole: OrgRole
}): Either<UserValidationError, User> {
  const now = new Date()
  const result = UserFactory.validate({
    ...input,
    id: uuidv7(),
    status: MembershipStatus.ACTIVE,
    roles: [],
    createdAt: now,
    updatedAt: now
  })
  return result
}
