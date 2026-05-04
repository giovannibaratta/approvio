import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"

/**
 * Extracts and validates the timestamp from a migration ID.
 * The ID should have the format YYYYMMDDHHMMSS-<arbitrary-string>
 *
 * @param id - The migration ID to validate
 * @returns Either an error or the extracted 14-character timestamp
 */
export const extractMigrationTimestamp = (id: string): E.Either<string, string> => {
  if (!id.includes("-")) return E.left(`Invalid migration ID format. Found ${id}. Expected YYYYMMDDHHMMSS-description.`)

  const timestamp = id.split("-")[0]

  if (timestamp === undefined || timestamp.length !== 14 || !/^\d+$/.test(timestamp))
    return E.left(`Invalid migration ID format. Found ${id}. Expected YYYYMMDDHHMMSS-description.`)

  return E.right(timestamp)
}

/**
 * Compares a migration timestamp against a required minimum timestamp.
 *
 * @param current - The current migration timestamp (YYYYMMDDHHMMSS)
 * @param required - The required minimum migration timestamp (YYYYMMDDHHMMSS)
 * @param fullId - The full migration ID for error reporting
 * @returns Either an error or void if the check passes
 */
export const validateMigrationTimestamp = (
  current: string,
  required: string,
  fullId: string
): E.Either<string, void> => {
  // Both strings use the fixed format YYYYMMDDHHmmss, which is lexicographically sortable.
  // This allows for a direct string comparison that is equivalent to chronological comparison.
  if (current < required)
    return E.left(
      `Database version mismatch. Required minimum: ${required}, Found latest: ${fullId}. Please update your database.`
    )

  return E.right(undefined)
}

/**
 * Combines timestamp extraction and validation.
 *
 * @param id - The migration ID to check
 * @param requiredTimestamp - The required minimum timestamp
 * @returns Either an error or void if the check passes
 */
export const checkMigrationId = (id: string, requiredTimestamp: string): E.Either<string, void> => {
  return pipe(
    extractMigrationTimestamp(id),
    E.chain(timestamp => validateMigrationTimestamp(timestamp, requiredTimestamp, id))
  )
}
