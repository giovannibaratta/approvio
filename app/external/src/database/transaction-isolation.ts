import {Prisma} from "@prisma/client"

// Prisma defines the available values; their relative strength is defined here.
const ISOLATION_STRICTNESS: Record<Prisma.TransactionIsolationLevel, number> = {
  ReadUncommitted: 1,
  ReadCommitted: 2,
  RepeatableRead: 3,
  Serializable: 4
}

/** A nested operation can use an equal or stronger existing transaction. */
export function isIsolationLevelSufficient(
  active: Prisma.TransactionIsolationLevel,
  required: Prisma.TransactionIsolationLevel
): boolean {
  return ISOLATION_STRICTNESS[active] >= ISOLATION_STRICTNESS[required]
}
