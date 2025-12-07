import {Prisma} from "@prisma/client"

export function mapToJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value

  if (Array.isArray(value)) return value.map(mapToJsonValue)

  if (typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, mapToJsonValue(val)]))

  return null
}
