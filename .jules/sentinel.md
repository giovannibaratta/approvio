# Sentinel's Journal

## 2026-02-15 - Fail-Open Authorization Logic

**Vulnerability:** Found a "Fail Open" pattern in `RolePermissionChecker.scopeMatches` where unhandled scope types would default to `true` (allow access), potentially bypassing authorization checks if new scope types were added without updating the logic.
**Learning:** Default return values in authorization checks must always be restrictive (`false` or `deny`). Code that relies on "falling through" to a default should fall to a safe state.
**Prevention:** Always implement "Fail Closed" logic. When checking permissions, start with `false` and only switch to `true` if an explicit allow condition is met. Use exhaustive checks (like TypeScript's `never` check) in switch statements or if-else chains to ensure all cases are handled, but still default to `false` as a safety net.

## 2025-05-05 - Missing Authorization Check on Sensitive Endpoint
**Vulnerability:** The `listOrganizationAdmins` endpoint was missing an authorization check, allowing any authenticated user to list organization admins.
**Learning:** Controller endpoints that delegate to services must explicitly pass the `AuthenticatedEntity` (requestor) to the service, and the service must validate it. Pagination parameters alone are insufficient for sensitive data access.
**Prevention:** Ensure all service methods that access sensitive data accept `RequestorAwareRequest` and validate `requestor.orgRole` or other permissions at the start of the method. Use unit tests that specifically check for `Left("requestor_not_authorized")` when a non-privileged user is passed.
