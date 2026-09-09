import {AuditLogFactory} from "../src/audit-log"
import {isLeft, isRight} from "fp-ts/Either"
import {v7 as uuidv7} from "uuid"

describe("AuditLogFactory", () => {
  const organizationId = uuidv7()
  const baseActor = {id: "user-id", type: "user", displayName: "Test User"}
  const baseAudit = {
    id: "audit-id",
    organizationId,
    actor: baseActor,
    createdAt: new Date()
  }

  describe("MembershipsAddedAuditLog", () => {
    it("should validate a valid payload", () => {
      // Given
      const data = {
        ...baseAudit,
        auditType: "MEMBERSHIPS_ADDED",
        entityType: "GROUP",
        entityId: "group-id",
        payload: {
          members: [
            {entityId: "user-1", entityType: "user", organizationId},
            {entityId: "agent-1", entityType: "agent", organizationId}
          ]
        }
      }

      // When
      const result = AuditLogFactory.validate(data)

      // Expect
      expect(isRight(result)).toBe(true)
    })

    it("should fail on invalid entityType in members", () => {
      // Given
      const data = {
        ...baseAudit,
        auditType: "MEMBERSHIPS_ADDED",
        entityType: "GROUP",
        entityId: "group-id",
        payload: {
          members: [{entityId: "user-1", entityType: "invalid", organizationId}]
        }
      }

      // When
      const result = AuditLogFactory.validate(data)

      // Expect
      expect(isLeft(result)).toBe(true)
    })
  })

  describe("UserRolesAssignedAuditLog", () => {
    it("should validate a valid payload with RoleScope", () => {
      // Given
      const data = {
        ...baseAudit,
        auditType: "USER_ROLES_ASSIGNED",
        entityType: "USER",
        entityId: "user-id",
        payload: {
          roles: [
            {
              roleName: "Admin",
              scope: {type: "org", organizationId}
            },
            {
              roleName: "SpaceManager",
              scope: {type: "space", organizationId, spaceId: uuidv7()}
            }
          ]
        }
      }

      // When
      const result = AuditLogFactory.validate(data)

      // Expect
      expect(isRight(result)).toBe(true)
    })

    it("should fail on invalid scope", () => {
      // Given
      const data = {
        ...baseAudit,
        auditType: "USER_ROLES_ASSIGNED",
        entityType: "USER",
        entityId: "user-id",
        payload: {
          roles: [
            {
              roleName: "Admin",
              scope: {type: "invalid"}
            }
          ]
        }
      }

      // When
      const result = AuditLogFactory.validate(data)

      // Expect
      expect(isLeft(result)).toBe(true)
    })
  })
})
