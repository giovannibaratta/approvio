import {UnconstrainedBoundRole, RoleScope} from "../src/role"
import {RolePermissionChecker} from "../src/permission-checker"

describe("RolePermissionChecker Vulnerability Check", () => {
  it("should fail closed (deny access) when an unknown scope type is encountered", () => {
    // malicious or new scope type
    const unknownScope = {
      type: "unknown_scope_type",
      someId: "123"
    } as any as RoleScope

    const roleWithUnknownScope: UnconstrainedBoundRole = {
      name: "TestRole",
      resourceType: "group", // doesn't matter much here
      permissions: ["read"],
      scopeType: "group", // doesn't matter much here
      scope: unknownScope
    } as any as UnconstrainedBoundRole

    // If I have a role with "unknown_scope_type" and I request access to "unknown_scope_type"
    // The current implementation will fall through the specific checks and return TRUE.

    // We access the private method via casting to any or using a public method if possible.
    // The public methods call hasPermission which calls scopeMatches.
    // However, the public methods enforce specific scope types (GroupScope, SpaceScope, etc).
    // So to trigger this, we need to bypass the type system or simulate a situation where
    // a new type was added to the system but scopeMatches wasn't updated.

    // We can use `RolePermissionChecker["scopeMatches"]` if we can access private static.
    // Or we can try to use `hasGroupPermission` but cast the scope to something else?
    // No, `hasGroupPermission` expects GroupScope.

    // Let's try to access the private method directly for this vulnerability proof.
    const hasMatch = (RolePermissionChecker as any).scopeMatches(unknownScope, unknownScope)

    // CURRENT BEHAVIOR: It returns false (FAIL CLOSED)
    // EXPECTED BEHAVIOR: It should return false (FAIL CLOSED)
    expect(hasMatch).toBe(false)
  })
})
