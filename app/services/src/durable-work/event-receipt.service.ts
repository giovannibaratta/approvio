import {Inject, Injectable} from "@nestjs/common"
import {TenantContext} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "../transaction/interfaces"
import {EVENT_RECEIPT_REPOSITORY_TOKEN, EventReceiptConsumer, EventReceiptRepository} from "./interfaces"

@Injectable()
export class EventReceiptService {
  constructor(
    @Inject(EVENT_RECEIPT_REPOSITORY_TOKEN) private readonly receipts: EventReceiptRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly transactions: TenantTransactionManager
  ) {}

  record(context: TenantContext, consumer: EventReceiptConsumer, eventId: string) {
    return this.transactions.execute(context, () =>
      pipe(
        this.receipts.record(context, consumer, eventId, new Date()),
        // Invalidate a relay candidate only when a new receipt changes what the relay can publish.
        TE.chainFirstW(outcome =>
          outcome === "new" ? this.receipts.advanceOutboxVersion(context, eventId) : TE.right(undefined)
        )
      )
    )
  }
}
