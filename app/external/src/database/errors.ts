import {Prisma} from "@prisma/client"

export function isPrismaUniqueConstraintError(error: unknown, fields: string[]): boolean {
  const uniqueFields = new Set(fields)
  if (uniqueFields.size !== fields.length) {
    throw new Error("Fields array contains duplicates")
  }

  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false
  }

  if (error.code !== "P2002" || !Array.isArray(error.meta?.target)) {
    return false
  }

  const violatedFields = error.meta.target as string[]
  return (
    fields.length === violatedFields.length &&
    fields.every(field => violatedFields.includes(field))
  )
}
