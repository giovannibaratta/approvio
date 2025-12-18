import {Prisma} from "@prisma/client"
import {DriverAdapterError, isDriverAdapterError} from "@prisma/driver-adapter-utils"

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

export function isPrismaUniqueConstraintError(error: unknown, fields: string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false

  const adapterError = getDriverAdapterError(error)
  if (!adapterError) return false

  const cause = adapterError.cause
  if (cause.kind !== "UniqueConstraintViolation") return false

  const violatedFields = cause.constraint && "fields" in cause.constraint ? cause.constraint.fields : []
  return fields.length === violatedFields.length && fields.every(field => violatedFields.includes(field))
}

export function isPrismaForeignKeyConstraintError(error: unknown, constraintName: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2003") return false

  const adapterError = getDriverAdapterError(error)
  if (!adapterError) return false

  const cause = adapterError.cause
  if (cause.kind !== "ForeignKeyConstraintViolation") return false

  return cause.constraint !== undefined && "index" in cause.constraint && cause.constraint.index === constraintName
}

export function isPrismaRecordNotFoundError(error: unknown, modelName: Prisma.ModelName): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2025") return false

  /**
   * P2025 "Record not found" is slightly different. Usually, the DB doesn't throw
   * an error for a missing record (it just returns 0 rows), so Prisma's engine
   * generates this error.
   *
   * Based on your captured debug log, 'modelName' is at the root of 'meta'.
   */
  const violatedModel = error.meta?.modelName as string | undefined

  return modelName === violatedModel
}
