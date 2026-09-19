import {randomOrgId} from "@test/organization-id"
import {GroupFactory} from "../src/group"
import {v7 as uuidv7} from "uuid"

describe("GroupFactory", () => {
  const organizationId = randomOrgId()

  describe("validate organization ID", () => {
    it("validates and brands a generic string organization ID", () => {
      const result = GroupFactory.newGroup({organizationId: uuidv7(), name: "team", description: null})

      expect(result).toBeRight()
    })

    it("rejects an invalid generic string organization ID", () => {
      const result = GroupFactory.newGroup({organizationId: "not-a-uuid", name: "team", description: null})

      expect(result).toBeLeftOf("group_invalid_organization_id")
    })
  })

  describe("newGroup name validation", () => {
    describe("good cases", () => {
      it("should allow valid names", () => {
        // Given
        const validNames = ["group-a", "GroupA", "group-1", "group-with-hyphens", "a", "A"]

        // When
        const results = validNames.map(name => GroupFactory.newGroup({organizationId, name, description: null}))

        // Then
        results.forEach(result => {
          expect(result).toBeRight()
        })
      })
    })

    describe("bad cases", () => {
      it("should not allow names with invalid characters", () => {
        // Given
        const invalidNames = ["group!", "group@", "group#", "group ", "group_"]

        // When
        const results = invalidNames.map(name => GroupFactory.newGroup({organizationId, name, description: null}))

        // Then
        results.forEach(result => {
          expect(result).toBeLeftOf("group_name_invalid_characters")
        })
      })

      it("should not allow names starting with a number", () => {
        // Given
        const name = "1group"

        // When
        const group = GroupFactory.newGroup({organizationId, name, description: null})

        // Then
        expect(group).toBeLeftOf("group_name_invalid_characters")
      })

      it("should not allow names starting with a hyphen", () => {
        // Given
        const name = "-group"

        // When
        const group = GroupFactory.newGroup({organizationId, name, description: null})

        // Then
        expect(group).toBeLeftOf("group_name_invalid_characters")
      })

      it("should not allow names ending with a hyphen", () => {
        // Given
        const name = "group-"

        // When
        const group = GroupFactory.newGroup({organizationId, name, description: null})

        // Then
        expect(group).toBeLeftOf("group_name_invalid_characters")
      })

      it('should return "group_name_empty" for empty names', () => {
        // Given
        const name = ""

        // When
        const group = GroupFactory.newGroup({organizationId, name, description: null})

        // Then
        expect(group).toBeLeftOf("group_name_empty")
      })

      it('should return "group_name_too_long" for long names', () => {
        // Given
        const longName = "a".repeat(513)

        // When
        const group = GroupFactory.newGroup({organizationId, name: longName, description: null})

        // Then
        expect(group).toBeLeftOf("group_name_too_long")
      })
    })
  })
})
