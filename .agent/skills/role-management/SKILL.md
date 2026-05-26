---
name: role-management
description: Detailed guide and workflow for defining new resources, permissions, or system roles in the RBAC system.
---

# Role and Permission Management Skill

This skill provides guidelines, architectural details, and a step-by-step implementation workflow for defining, modifying, or checking roles and permissions in the Approvio system.

---

## 1. Architecture & Design Patterns

Approvio utilizes a type-safe, compile-time enforced Role-Based Access Control (RBAC) system. The system guarantees consistency and prevents runtime errors by deriving types directly from a **Single Source of Truth** using TypeScript's type mapping and index access.

### The Single Source of Truth Cascading Chain
1. **`RESOURCE_TYPES`** (constant string array in [role.ts](file:///workspace/approvio/app/domain/src/role.ts)):
   - Defines all resource types present in the system (e.g., `"group"`, `"space"`, `"workflow_template"`, `"audit"`).
2. **`ResourceType`** (derived union type):
   - Extracted automatically via `(typeof RESOURCE_TYPES)[number]`.
3. **`ALLOWED_SCOPE_TYPES_BY_RESOURCE`** and **`RESOURCE_PERMISSIONS`** (constant configurations):
   - Constraints are enforced using `satisfies Record<ResourceType, ...>` to guarantee at compile time that every resource type has defined scopes and permissions.
4. **Derived Permission Types**:
   - Specific permission unions (e.g., `GroupPermission`, `SpacePermission`) are derived from `RESOURCE_PERMISSIONS` arrays using indexed access types (e.g. `(typeof RESOURCE_PERMISSIONS)["group"][number]`).
5. **`ResourceScopePermissionBinding`**:
   - Mapped type tying resource types to their permitted scopes and permissions.

### Hierarchical Scoping & Scope Matching
The permission system resolves scopes hierarchically:
- **Org Scope (`org`)**: Organization-wide permissions act as a root scope. A user with org-level permissions automatically matches all child scopes (groups, spaces, templates) under that organization.
- **Specific Scopes (`space`, `group`, `workflow_template`)**: These scopes restrict permissions to resources matching the specific identifier (e.g. `spaceId`, `groupId`, or `templateName`).

---

## 2. Step-by-Step Implementation Workflow

To introduce a new resource type, permission, or standard system role, you must perform the following 4 steps.

### Step 1: Update `app/domain/src/role.ts`
1. Add the new resource type to the `RESOURCE_TYPES` array if you are adding a new domain resource:
   ```typescript
   export const RESOURCE_TYPES = ["group", "space", "workflow_template", "audit", "my_new_resource"] as const
   ```
2. Map the resource to its allowed scopes in `ALLOWED_SCOPE_TYPES_BY_RESOURCE`:
   ```typescript
   my_new_resource: ["org", "space"]
   ```
3. Add the valid permission keys in `RESOURCE_PERMISSIONS`:
   ```typescript
   my_new_resource: ["read", "write", "manage"]
   ```
4. Define derived type aliases for permissions, templates, and bound roles:
   ```typescript
   export type MyNewResourcePermission = (typeof RESOURCE_PERMISSIONS)["my_new_resource"][number]
   export type MyNewResourceRoleTemplate = RoleTemplate<"my_new_resource">
   export type MyNewResourceRole = BoundRole<"my_new_resource">
   ```

### Step 2: Update `app/domain/src/system-role.ts`
1. Define a template getter method for the standard role (using scope-specific naming where applicable):
   ```typescript
   static getMyNewResourceViewerTemplate(scopeType: MyNewResourceRoleTemplate["scopeType"] = "org"): MyNewResourceRoleTemplate {
     const baseRoleName = "MyNewResourceViewer"
     const name = scopeType === "org" ? baseRoleName : SystemRole.generateRoleName("MyNewResourceViewer", scopeType)

     return {
       name,
       resourceType: "my_new_resource",
       permissions: ["read"],
       scopeType
     }
   }
   ```
2. Include the template in `getAllSystemRoleTemplates()` to ensure it's registered in the system cache:
   ```typescript
   static getAllSystemRoleTemplates(): ReadonlyArray<RoleTemplate> {
     return [
       // ... other templates ...
       SystemRole.getMyNewResourceViewerTemplate("org"),
       SystemRole.getMyNewResourceViewerTemplate("space")
     ]
   }
   ```
3. Provide a convenience bound role factory method:
   ```typescript
   static createMyNewResourceViewerRole(scope: RoleScope): MyNewResourceRole {
     return SystemRole.createRoleForScope(SystemRole.getMyNewResourceViewerTemplate(), scope)
   }
   ```

### Step 3: Update `app/domain/src/permission-checker.ts`
Add a dedicated static verification helper on `RolePermissionChecker` using the derived permission and scope types:
```typescript
static hasMyNewResourcePermission(
  roles: ReadonlyArray<UnconstrainedBoundRole>,
  scope: OrgScope | SpaceScope,
  permission: MyNewResourcePermission
): boolean {
  return this.hasPermission(roles, scope, permission)
}
```

### Step 4: Apply in the Service Layer
In the NestJS backend services:
1. Import `RolePermissionChecker` and `getEntityRoles` from `@domain`.
2. Extract the requester's bound roles using `getEntityRoles(requestor)`.
3. Call the appropriate permission checker helper.

**Example from `AuditLogService`**:
```typescript
import { AuthenticatedEntity, getEntityRoles, RolePermissionChecker } from "@domain"

@Injectable()
export class AuditLogService {
  public listAuditLogs(requestor: AuthenticatedEntity) {
    const isOrgAdmin = requestor.entityType === "user" && requestor.user.orgRole === "admin"
    const isAuditor = RolePermissionChecker.hasAuditPermission(
      getEntityRoles(requestor), 
      { type: "org" }, 
      "read"
    )

    if (!isOrgAdmin && !isAuditor) {
      return TE.left("requestor_not_authorized" as const)
    }
    // Proceed with business logic...
  }
}
```

---

## 3. Verification & Testing

Every role or permission modification MUST be verified via domain unit tests:
1. **Open the Test File**: Open [permission-checker.test.ts](file:///workspace/approvio/app/domain/test/permission-checker.test.ts).
2. **Add Test Cases**: Write comprehensive tests validating that:
   - The role templates have the expected permission arrays.
   - The permission checker correctly verifies matching scopes.
   - Org-scoped roles correctly cascade/match child scopes.
   - Incompatible scopes are correctly rejected.
3. **Execute Tests**:
   - Run tests for the domain package using `yarn test` inside the `/workspace/approvio/` directory or run specific tests:
     ```bash
     yarn test app/domain/test/permission-checker.test.ts
     ```
