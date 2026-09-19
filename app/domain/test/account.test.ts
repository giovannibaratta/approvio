import {AccountFactory, AccountStatus} from "../src/account"
import {v7 as uuidv7} from "uuid"
import {unwrapRight} from "@utils/either"

describe("AccountFactory", () => {
  const validId = uuidv7()
  const validDate = new Date("2026-01-01T00:00:00.000Z")

  const createValidAccountData = () => ({
    id: validId,
    displayName: "Alice Doe",
    profileEmail: "alice@example.com",
    status: "active" as AccountStatus,
    createdAt: validDate,
    updatedAt: validDate
  })

  describe("validate", () => {
    it("validates and brands valid account data with trimmed displayName", () => {
      const data = {...createValidAccountData(), displayName: "  Alice Doe  "}
      const result = AccountFactory.validate(data)

      expect(result).toBeRight()
      const account = unwrapRight(result)
      expect(account.id).toBe(validId)
      expect(account.displayName).toBe("Alice Doe")
      expect(account.profileEmail).toBe("alice@example.com")
      expect(account.status).toBe("active")
    })

    it("fails when input is not an object", () => {
      expect(AccountFactory.validate(null)).toBeLeftOf("account_malformed_object")
      expect(AccountFactory.validate(undefined)).toBeLeftOf("account_malformed_object")
      expect(AccountFactory.validate("string")).toBeLeftOf("account_malformed_object")
      expect(AccountFactory.validate([])).toBeLeftOf("account_malformed_object")
    })

    it("fails on invalid id", () => {
      const data = {...createValidAccountData(), id: "not-a-uuid"}
      expect(AccountFactory.validate(data)).toBeLeftOf("account_invalid_uuid")
    })

    it("fails on empty or whitespace display name", () => {
      expect(AccountFactory.validate({...createValidAccountData(), displayName: ""})).toBeLeftOf(
        "account_display_name_empty"
      )
      expect(AccountFactory.validate({...createValidAccountData(), displayName: "   "})).toBeLeftOf(
        "account_display_name_empty"
      )
    })

    it("fails on overly long display name", () => {
      const longName = "a".repeat(256)
      expect(AccountFactory.validate({...createValidAccountData(), displayName: longName})).toBeLeftOf(
        "account_display_name_too_long"
      )
    })

    it("fails on invalid profile email", () => {
      expect(AccountFactory.validate({...createValidAccountData(), profileEmail: "not-an-email"})).toBeLeftOf(
        "account_invalid_profile_email"
      )
    })

    it("fails on invalid status", () => {
      expect(AccountFactory.validate({...createValidAccountData(), status: "unknown"})).toBeLeftOf(
        "account_invalid_status"
      )
    })

    it("fails on invalid date types", () => {
      expect(AccountFactory.validate({...createValidAccountData(), createdAt: "2026-01-01"})).toBeLeftOf(
        "account_malformed_object"
      )
      expect(AccountFactory.validate({...createValidAccountData(), updatedAt: 123456789})).toBeLeftOf(
        "account_malformed_object"
      )
    })

    it("fails when createdAt is after updatedAt", () => {
      const data = {
        ...createValidAccountData(),
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z")
      }
      expect(AccountFactory.validate(data)).toBeLeftOf("account_update_before_create")
    })
  })
})
