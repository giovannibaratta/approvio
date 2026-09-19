import {Process, Processor} from "@nestjs/bull"
import {Inject} from "@nestjs/common"
import {TenantOutboxRelayService} from "@services/durable-work"
import {isLeft} from "fp-ts/Either"
import {TENANT_OUTBOX_RELAY_QUEUE} from "@external"
import {WORKER_ID} from "../worker.constants"

/** Runs the service-layer outbox relay when the scheduled queue job fires. */
@Processor(TENANT_OUTBOX_RELAY_QUEUE)
export class TenantOutboxRelayProcessor {
  constructor(
    private readonly relayService: TenantOutboxRelayService,
    @Inject(WORKER_ID) private readonly workerId: string
  ) {}

  @Process("relay-tenant-outbox")
  async relay(): Promise<void> {
    const result = await this.relayService.relay(this.workerId)()
    if (isLeft(result)) throw new Error(`Tenant outbox relay failed: ${result.left}`)
  }
}
