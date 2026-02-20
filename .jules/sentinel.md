# Sentinel's Journal

## 2026-02-15 - Fail-Open Authorization Logic

**Vulnerability:** Found a "Fail Open" pattern in `RolePermissionChecker.scopeMatches` where unhandled scope types would default to `true` (allow access), potentially bypassing authorization checks if new scope types were added without updating the logic.
**Learning:** Default return values in authorization checks must always be restrictive (`false` or `deny`). Code that relies on "falling through" to a default should fall to a safe state.
**Prevention:** Always implement "Fail Closed" logic. When checking permissions, start with `false` and only switch to `true` if an explicit allow condition is met. Use exhaustive checks (like TypeScript's `never` check) in switch statements or if-else chains to ensure all cases are handled, but still default to `false` as a safety net.

## 2026-02-15 - Missing Authorization in Service Method

**Vulnerability:** `OrganizationAdminService.listOrganizationAdmins` exposed an endpoint without any authorization check because the method signature did not accept the requestor, making authorization checks impossible at the service layer.
**Learning:** Service methods that perform sensitive actions must always be "Requestor Aware" to enforce authorization logic closer to the data, rather than relying solely on Controllers (which might forget to check).
**Prevention:** Enforce a pattern where all sensitive service methods accept `RequestorAwareRequest`. Use linting or architectural reviews to flag public service methods that don't take a user context.
