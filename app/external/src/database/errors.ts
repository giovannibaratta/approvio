import {Prisma} from "@prisma/client"
import {DriverAdapterError, isDriverAdapterError} from "@prisma/driver-adapter-utils"

const PRISMA_DATABASE_NOT_REACHABLE_ERROR_CODE = "P1001"
const PRISMA_DATABASE_CONNECTION_TIMEOUT_ERROR_CODE = "P1002"
const PRISMA_OPERATION_TIMEOUT_ERROR_CODE = "P1008"
const PRISMA_CONNECTION_CLOSED_ERROR_CODE = "P1017"
const PRISMA_UNIQUE_CONSTRAINT_ERROR_CODE = "P2002"
const PRISMA_FOREIGN_KEY_CONSTRAINT_ERROR_CODE = "P2003"
const PRISMA_CONNECTION_POOL_TIMEOUT_ERROR_CODE = "P2024"
const PRISMA_RECORD_NOT_FOUND_ERROR_CODE = "P2025"
const PRISMA_TOO_MANY_CONNECTIONS_ERROR_CODE = "P2037"

const POSTGRES_CONNECTION_EXCEPTION_ERROR_CODE = "08000"
const POSTGRES_UNABLE_TO_ESTABLISH_CONNECTION_ERROR_CODE = "08001"
const POSTGRES_CONNECTION_DOES_NOT_EXIST_ERROR_CODE = "08003"
const POSTGRES_CONNECTION_FAILURE_ERROR_CODE = "08006"
const POSTGRES_ADMIN_SHUTDOWN_ERROR_CODE = "57P01"
const POSTGRES_CRASH_SHUTDOWN_ERROR_CODE = "57P02"
const POSTGRES_CANNOT_CONNECT_NOW_ERROR_CODE = "57P03"

// Reference for error structure https://github.com/prisma/prisma/blob/7.2.0/packages/driver-adapter-utils/src/types.ts
//
// The cause of the DriverAdapterError is a discriminated union of types that can be narrowed down
// to extract the specific error details.

/**
 * Helper to safely extract driver-specific details from the adapter error.
 */
function getDriverAdapterError(error: Prisma.PrismaClientKnownRequestError): DriverAdapterError | undefined {
  const adapterError = error.meta?.driverAdapterError
  if (adapterError && isDriverAdapterError(adapterError)) return adapterError
  return undefined
}

/**
 * Connection failures, timeouts and pool exhaustion can recover on a bounded retry.
 * Authentication, schema and unclassified errors are deliberately excluded.
 * Prisma codes: https://www.prisma.io/docs/orm/reference/error-reference
 */
export function isTemporaryDatabaseError(error: unknown): boolean {
  const code =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : error instanceof Prisma.PrismaClientInitializationError
        ? error.errorCode
        : undefined
  if (
    code !== undefined &&
    [
      PRISMA_DATABASE_NOT_REACHABLE_ERROR_CODE,
      PRISMA_DATABASE_CONNECTION_TIMEOUT_ERROR_CODE,
      PRISMA_OPERATION_TIMEOUT_ERROR_CODE,
      PRISMA_CONNECTION_CLOSED_ERROR_CODE,
      PRISMA_CONNECTION_POOL_TIMEOUT_ERROR_CODE,
      PRISMA_TOO_MANY_CONNECTIONS_ERROR_CODE
    ].includes(code)
  )
    return true

  const adapterError = isDriverAdapterError(error)
    ? error
    : error instanceof Prisma.PrismaClientKnownRequestError
      ? getDriverAdapterError(error)
      : undefined
  if (adapterError === undefined) return false
  switch (adapterError.cause.kind) {
    case "DatabaseNotReachable":
    case "ConnectionClosed":
    case "SocketTimeout":
    case "TooManyConnections":
      return true
    case "postgres":
      // PostgreSQL preserves these connection and shutdown conditions as SQLSTATE codes.
      // https://www.postgresql.org/docs/current/errcodes-appendix.html
      return [
        POSTGRES_CONNECTION_EXCEPTION_ERROR_CODE,
        POSTGRES_UNABLE_TO_ESTABLISH_CONNECTION_ERROR_CODE,
        POSTGRES_CONNECTION_DOES_NOT_EXIST_ERROR_CODE,
        POSTGRES_CONNECTION_FAILURE_ERROR_CODE,
        POSTGRES_ADMIN_SHUTDOWN_ERROR_CODE,
        POSTGRES_CRASH_SHUTDOWN_ERROR_CODE,
        POSTGRES_CANNOT_CONNECT_NOW_ERROR_CODE
      ].includes(adapterError.cause.code)
    default:
      return false
  }
}

/**
 * Matches a unique violation by its reported fields. PostgreSQL can omit column
 * details under tenant RLS, so constraintName optionally provides a fallback
 * match against the original error message. Either match is sufficient.
 */
export function isPrismaUniqueConstraintError(error: unknown, fields: string[], constraintName?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== PRISMA_UNIQUE_CONSTRAINT_ERROR_CODE)
    return false

  const adapterError = getDriverAdapterError(error)
  if (!adapterError) return false

  const cause = adapterError.cause
  if (cause.kind !== "UniqueConstraintViolation") return false

  const violatedFields = cause.constraint && "fields" in cause.constraint ? cause.constraint.fields : []
  if (fields.length === violatedFields.length && fields.every(field => violatedFields.includes(field))) return true

  return (
    constraintName !== undefined &&
    "originalMessage" in cause &&
    typeof cause.originalMessage === "string" &&
    cause.originalMessage.includes(`unique constraint "${constraintName}"`)
  )
}

export function isPrismaForeignKeyConstraintError(error: unknown, constraintName: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== PRISMA_FOREIGN_KEY_CONSTRAINT_ERROR_CODE
  )
    return false

  const adapterError = getDriverAdapterError(error)
  if (!adapterError) return false

  const cause = adapterError.cause
  if (cause.kind !== "ForeignKeyConstraintViolation") return false

  return cause.constraint !== undefined && "index" in cause.constraint && cause.constraint.index === constraintName
}

export function isPrismaRecordNotFoundError(error: unknown, modelName: Prisma.ModelName): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== PRISMA_RECORD_NOT_FOUND_ERROR_CODE)
    return false

  /**
   * P2025 "Record not found" is slightly different. Usually, the DB doesn't throw
   * an error for a missing record (it just returns 0 rows), so Prisma's engine
   * generates this error.
   */
  const violatedModel = error.meta?.modelName as string | undefined

  return modelName === violatedModel
}
