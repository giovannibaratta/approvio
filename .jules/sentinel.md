# Sentinel's Journal

## 2026-02-15 - Fail-Open Authorization Logic

**Vulnerability:** Found a "Fail Open" pattern in `RolePermissionChecker.scopeMatches` where unhandled scope types would default to `true` (allow access), potentially bypassing authorization checks if new scope types were added without updating the logic.
**Learning:** Default return values in authorization checks must always be restrictive (`false` or `deny`). Code that relies on "falling through" to a default should fall to a safe state.
**Prevention:** Always implement "Fail Closed" logic. When checking permissions, start with `false` and only switch to `true` if an explicit allow condition is met. Use exhaustive checks (like TypeScript's `never` check) in switch statements or if-else chains to ensure all cases are handled, but still default to `false` as a safety net.

## 2026-03-03 - Implicit Service Authorization Gap
**Vulnerability:** `listUsers` endpoint allowed user enumeration by any authenticated user because authorization checks were missing in both the controller (via `@GetAuthenticatedEntity` but no check) and the service layer.
**Learning:** In this architecture, authorization logic often resides in the Service layer (`UserService`), but the `requestor` context must be explicitly passed from the Controller. If a method signature doesn't include `requestor`, it's a strong signal that authorization might be missing.
**Prevention:** Always verify that Service methods performing sensitive operations (like listing users) accept `requestor` (RequestorAwareRequest) and perform an explicit role check (e.g., `user.orgRole === 'admin'`). Use integration tests that specifically assert 403 Forbidden for unauthorized roles.
