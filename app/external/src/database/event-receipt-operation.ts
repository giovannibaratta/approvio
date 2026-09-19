import {Prisma} from "@prisma/client"

import type {EventReceiptConsumer} from "@services"
export type EventReceiptResult = "new" | "duplicate"

export async function recordTenantEventReceipt(
  tx: Pick<Prisma.TransactionClient, "tenantEventReceipt">,
  organizationId: string,
  consumer: EventReceiptConsumer,
  eventId: string
): Promise<EventReceiptResult> {
  const inserted = await tx.tenantEventReceipt.createMany({
    data: [{organizationId, consumer, eventId, processedAt: new Date()}],
    skipDuplicates: true
  })
  return inserted.count === 1 ? "new" : "duplicate"
}
