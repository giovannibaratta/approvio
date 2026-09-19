import {Prisma} from "@prisma/client"

import type {EventReceiptConsumer} from "@services"
export type EventReceiptResult = "new" | "duplicate"

export async function recordTenantEventReceipt(
  tx: Pick<Prisma.TransactionClient, "tenantEventReceipt" | "tenantOutbox">,
  organizationId: string,
  consumer: EventReceiptConsumer,
  eventId: string
): Promise<EventReceiptResult> {
  const inserted = await tx.tenantEventReceipt.createMany({
    // TODO: Processed at should be set by the service/domain.
    data: [{organizationId, consumer, eventId, processedAt: new Date()}],
    skipDuplicates: true
  })
  // TODO: This could mask a bug if in the future we will persist more than one element.
  if (inserted.count !== 1) return "duplicate"
  // TODO: also I don't like this create + update thing, any other solution ?
  await tx.tenantOutbox.update({
    where: {organizationId_eventId: {organizationId, eventId}},
    data: {occ: {increment: 1}}
  })
  return "new"
}
