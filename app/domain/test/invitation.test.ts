import {InvitationFactory, OrgRole} from "@domain"

describe("invitation domain", () => {
  it("prevents admins from granting owner role", () => {
    expect(InvitationFactory.canGrant(OrgRole.ADMIN, OrgRole.OWNER)).toBe(false)
    expect(InvitationFactory.canGrant(OrgRole.OWNER, OrgRole.OWNER)).toBe(true)
  })
})
