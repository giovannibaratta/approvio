import {randomOrgId} from "@test/organization-id"
import {UserFactory} from "../src/user"
import {v7 as uuidv7} from "uuid"

describe("UserFactory.validate", () => {
  const validData = () => {
    const now = new Date()
    return {
      id: uuidv7(),
      organizationId: randomOrgId(),
      accountId: uuidv7(),
      displayName: "Alice",
      status: "active",
      orgRole: "member",
      roles: [],
      createdAt: now,
      updatedAt: now
    }
  }

  it("validates persisted membership status values", () => {
    expect(UserFactory.validate({...validData(), status: "invalid"})).toBeLeftOf("user_status_invalid")
  })

  it("validates persisted organization role values", () => {
    expect(UserFactory.validate({...validData(), orgRole: "invalid"})).toBeLeftOf("user_org_role_invalid")
  })
})
