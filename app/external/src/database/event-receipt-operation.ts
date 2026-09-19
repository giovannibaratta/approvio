import {Prisma} from "@prisma/client"

export type EventReceiptConsumer = "recalculation" | "task_generation" | "task_dispatch" | "lifecycle" | "usage"
export type EventReceiptResult = "new" | "duplicate" | "organization_mismatch"

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
