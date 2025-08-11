import {OrganizationAdminFactory, ORG_ADMIN_EMAIL_MAX_LENGTH} from "@domain/organization-admin"
import {randomUUID} from "crypto"
import "@utils/matchers"

describe("OrganizationAdminFactory", () => {
  describe("newOrganizationAdmin", () => {
    describe("good cases", () => {
      it("should create valid organization admin with proper email", () => {
        // Given: Valid organization admin data
        const adminData = {
          email: "admin@example.com"
        }

        // When: Creating new organization admin
        const result = OrganizationAdminFactory.newOrganizationAdmin(adminData)

        // Expect: Success with valid organization admin
        expect(result).toBeRight()
        expect(result).toBeRightOf(
          expect.objectContaining({
            email: "admin@example.com",
            id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
            createdAt: expect.any(Date)
          })
        )
      })

      it("should create valid organization admin with maximum length email", () => {
        // Given: Organization admin data with maximum length email
        const longEmail = "a".repeat(ORG_ADMIN_EMAIL_MAX_LENGTH - "@test.com".length) + "@test.com"
        const adminData = {
          email: longEmail
        }

        // When: Creating new organization admin
        const result = OrganizationAdminFactory.newOrganizationAdmin(adminData)

        // Expect: Success
        expect(result).toBeRight()
      })
    })

    describe("bad cases", () => {
      it("should reject empty email", () => {
        // Given: Organization admin data with empty email
        const adminData = {
          email: ""
        }

        // When: Creating new organization admin
        const result = OrganizationAdminFactory.newOrganizationAdmin(adminData)

        // Expect: Validation error
        expect(result).toBeLeftOf("organization_admin_email_empty")
      })

      it("should reject whitespace-only email", () => {
        // Given: Organization admin data with whitespace-only email
        const adminData = {
          email: "   "
        }

        // When: Creating new organization admin
        const result = OrganizationAdminFactory.newOrganizationAdmin(adminData)

        // Expect: Validation error
        expect(result).toBeLeftOf("organization_admin_email_empty")
      })

      it("should reject too long email", () => {
        // Given: Organization admin data with too long email
        const longEmail = "a".repeat(ORG_ADMIN_EMAIL_MAX_LENGTH + 1) + "@test.com"
        const adminData = {
          email: longEmail
        }

        // When: Creating new organization admin
        const result = OrganizationAdminFactory.newOrganizationAdmin(adminData)

        // Expect: Validation error
        expect(result).toBeLeftOf("organization_admin_email_too_long")
      })

      it("should reject invalid email format", () => {
        // Given: Organization admin data with invalid email
        const adminData = {
          email: "invalid-email"
        }

        // When: Creating new organization admin
        const result = OrganizationAdminFactory.newOrganizationAdmin(adminData)

        // Expect: Validation error
        expect(result).toBeLeftOf("organization_admin_email_invalid")
      })
    })
  })

  describe("validate", () => {
    describe("good cases", () => {
      it("should validate existing organization admin object", () => {
        // Given: Valid organization admin data
        const adminData = {
          id: randomUUID(),
          email: "admin@example.com",
          createdAt: new Date()
        }

        // When: Validating organization admin
        const result = OrganizationAdminFactory.validate(adminData)

        // Expect: Success
        expect(result).toBeRight()
      })
    })

    describe("bad cases", () => {
      it("should reject invalid UUID", () => {
        // Given: Organization admin data with invalid UUID
        const adminData = {
          id: "invalid-uuid",
          email: "admin@example.com",
          createdAt: new Date()
        }

        // When: Validating organization admin
        const result = OrganizationAdminFactory.validate(adminData)

        // Expect: Validation error
        expect(result).toBeLeftOf("organization_admin_invalid_uuid")
      })

      it("should reject invalid email in existing object", () => {
        // Given: Organization admin data with invalid email
        const adminData = {
          id: randomUUID(),
          email: "invalid-email",
          createdAt: new Date()
        }

        // When: Validating organization admin
        const result = OrganizationAdminFactory.validate(adminData)

        // Expect: Validation error
        expect(result).toBeLeftOf("organization_admin_email_invalid")
      })
    })
  })
})
