# Sentinel's Journal

## 2026-02-15 - Fail-Open Authorization Logic

**Vulnerability:** Found a "Fail Open" pattern in `RolePermissionChecker.scopeMatches` where unhandled scope types would default to `true` (allow access), potentially bypassing authorization checks if new scope types were added without updating the logic.
**Learning:** Default return values in authorization checks must always be restrictive (`false` or `deny`). Code that relies on "falling through" to a default should fall to a safe state.
**Prevention:** Always implement "Fail Closed" logic. When checking permissions, start with `false` and only switch to `true` if an explicit allow condition is met. Use exhaustive checks (like TypeScript's `never` check) in switch statements or if-else chains to ensure all cases are handled, but still default to `false` as a safety net.

## 2026-02-15 - Broken Object Level Authorization (BOLA) in User Listing
**Vulnerability:** The `listUsers` endpoint was accessible to any authenticated user, allowing full enumeration of all users (names, emails, roles).
**Learning:** Default `JwtAuthGuard` only ensures authentication, not authorization. Service methods that return sensitive data collections must enforce role checks (RBAC) explicitly.
**Prevention:** Always implement an authorization check (e.g., verifying `orgRole === 'admin'`) in the service layer for bulk retrieval operations. Use `RequestorAwareRequest` to pass the authenticated entity context to the service.
