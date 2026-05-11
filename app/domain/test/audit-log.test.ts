import {AuditLogFactory} from "../src/audit-log"
import {isLeft, isRight} from "fp-ts/Either"

describe("AuditLogFactory", () => {
  const baseActor = {id: "user-id", type: "user"}
  const baseAudit = {
    id: "audit-id",
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
            {entityId: "user-1", entityType: "user"},
            {entityId: "agent-1", entityType: "agent"}
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
          members: [{entityId: "user-1", entityType: "invalid"}]
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
              scope: {type: "org"}
            },
            {
              roleName: "SpaceManager",
              scope: {type: "space", spaceId: "space-1"}
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
