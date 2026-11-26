import {Prisma} from "@prisma/client"

import type {EventReceiptConsumer} from "@services"
export type EventReceiptResult = "new" | "duplicate"

export async function recordTenantEventReceipt(
  tx: Pick<Prisma.TransactionClient, "tenantEventReceipt">,
  organizationId: string,
  consumer: EventReceiptConsumer,
  eventId: string,
  processedAt: Date
): Promise<EventReceiptResult> {
  const inserted = await tx.tenantEventReceipt.createMany({
    data: {organizationId, consumer, eventId, processedAt},
    skipDuplicates: true
  })
  if (inserted.count === 0) return "duplicate"
  if (inserted.count !== 1) throw new Error("Expected exactly one tenant event receipt")
  return "new"
}
