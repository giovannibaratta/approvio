# Sentinel's Journal

## 2026-02-15 - Fail-Open Authorization Logic

**Vulnerability:** Found a "Fail Open" pattern in `RolePermissionChecker.scopeMatches` where unhandled scope types would default to `true` (allow access), potentially bypassing authorization checks if new scope types were added without updating the logic.
**Learning:** Default return values in authorization checks must always be restrictive (`false` or `deny`). Code that relies on "falling through" to a default should fall to a safe state.
**Prevention:** Always implement "Fail Closed" logic. When checking permissions, start with `false` and only switch to `true` if an explicit allow condition is met. Use exhaustive checks (like TypeScript's `never` check) in switch statements or if-else chains to ensure all cases are handled, but still default to `false` as a safety net.

## 2026-02-18 - Missing Authorization on List Organization Admins Endpoint
**Vulnerability:** Found that `OrganizationAdminService.listOrganizationAdmins` did not verify the requestor's role, allowing any authenticated user to list all organization admins.
**Learning:** Endpoints that list resources often forget to check permissions if they don't explicitly require user context for filtering. Always check authorization even for read-only operations.
**Prevention:** Ensure all service methods accept `RequestorAwareRequest` and validate `requestor.orgRole` or other permissions explicitly. Add integration/unit tests that specifically check for Unauthorized/Forbidden responses.
