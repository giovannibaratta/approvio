import {Prisma} from "@prisma/client"

export function mapToNullableJsonValue(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (value === null || value === undefined) return Prisma.JsonNull

  return mapToJsonValue(value)
}

export function mapToJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === null || value === undefined) throw new Error("Value cannot be null or undefined")

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value

  if (Array.isArray(value)) return value.map(mapToJsonValue)

  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, mapToJsonValue(val)]))
}
