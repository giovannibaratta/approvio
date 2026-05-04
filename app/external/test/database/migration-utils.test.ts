import * as E from "fp-ts/Either"
import {
  extractMigrationTimestamp,
  validateMigrationTimestamp,
  checkMigrationId
} from "../../src/database/migration-utils"
import * as fs from "fs"
import * as path from "path"
import "@utils/matchers"
import {REQUIRED_DB_MIGRATION_TIMESTAMP} from "../../src/database/database-client"

describe("migration-utils", () => {
  describe("extractMigrationTimestamp", () => {
    it("should extract timestamp from valid migration ID", () => {
      const result = extractMigrationTimestamp("20260208132808-create-table")
      expect(result).toBeRightOf("20260208132808")
    })

    it("should return error for invalid timestamp length", () => {
      const result = extractMigrationTimestamp("20260208-create-table")
      expect(result).toBeLeft()
    })

    it("should return error for non-numeric timestamp", () => {
      const result = extractMigrationTimestamp("20260208ABCDEF-create-table")
      expect(E.isLeft(result)).toBe(true)
    })

    it("should return error if no hyphen is present", () => {
      const result = extractMigrationTimestamp("20260208132808")
      expect(result).toBeLeft()
    })
  })

  describe("validateMigrationTimestamp", () => {
    const HARDCODED_REQUIRED = "20260208132808"

    it("should return right(undefined) if current >= required", () => {
      expect(validateMigrationTimestamp(HARDCODED_REQUIRED, HARDCODED_REQUIRED, "id")).toBeRight()
      expect(validateMigrationTimestamp("20261231235959", HARDCODED_REQUIRED, "id")).toBeRight()
    })

    it("should return left(Error) if current < required", () => {
      const result = validateMigrationTimestamp("20260201120000", HARDCODED_REQUIRED, "old-id")
      expect(result).toBeLeft()
    })
  })

  describe("checkMigrationId", () => {
    const HARDCODED_REQUIRED = "20260208132808"

    it("should validate a valid and up-to-date migration ID", () => {
      expect(checkMigrationId(`${HARDCODED_REQUIRED}-description`, HARDCODED_REQUIRED)).toBeRight()
    })

    it("should return error for invalid format", () => {
      expect(checkMigrationId("invalid", HARDCODED_REQUIRED)).toBeLeft()
    })

    it("should return error for outdated migration", () => {
      expect(checkMigrationId("20260101000000-old", HARDCODED_REQUIRED)).toBeLeft()
    })
  })

  describe("REQUIRED_DB_MIGRATION_TIMESTAMP validation", () => {
    it("should be a valid 14-character numeric string", () => {
      expect(REQUIRED_DB_MIGRATION_TIMESTAMP).toMatch(/^\d{14}$/)
    })

    it("should match the timestamp of the latest migration file in db-migrations/v1", () => {
      const migrationsDir = path.resolve(__dirname, "../../../../db-migrations/v1")
      const files = fs.readdirSync(migrationsDir)

      const timestamps = files
        .filter(f => f.endsWith(".yaml") && f !== "root-v1.yaml")
        .map(f => f.split("-")[0])
        .sort()

      const latestTimestamp = timestamps[timestamps.length - 1]
      expect(REQUIRED_DB_MIGRATION_TIMESTAMP).toBe(latestTimestamp)
    })
  })

  describe("database migration directory validation", () => {
    it("should have all migration files following the expected format in db-migrations/v1", () => {
      const migrationsDir = path.resolve(__dirname, "../../../../db-migrations/v1")
      const files = fs.readdirSync(migrationsDir)

      const yamlFiles = files.filter(f => f.endsWith(".yaml") && f !== "root-v1.yaml")

      yamlFiles.forEach(file => {
        const id = file.replace(".yaml", "")
        const result = extractMigrationTimestamp(id)
        expect(result).toBeRight()
      })
    })
  })
})
