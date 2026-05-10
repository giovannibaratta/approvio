import {Prisma} from "@prisma/client"

export function mapToJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === null || value === undefined) throw new Error("Value cannot be null or undefined")
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return mapArray(value)

  return mapToNonNullableJsonValue(value)
}

function mapArray(value: unknown[]): Prisma.InputJsonArray {
  return value.map(mapToNullableNonRootElement)
}

function mapToNonNullableJsonValue(value: object): Prisma.InputJsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, mapToNullableNonRootElement(val)]))
}

// Nested elements in Prisma do not use Prisma.NullableJsonNullValueInput but the standard
// null value. Hence the need for having a dedicated function.
function mapToNullableNonRootElement(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null
  return mapToJsonValue(value)
}

export function mapToNullableJsonValue(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (value === null || value === undefined) return Prisma.JsonNull
  return mapToJsonValue(value)
}
