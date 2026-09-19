import {OutboxClaimCriteria} from "./interfaces"

const LEASE_DURATION_MS = 60_000
const EVENT_RECOVERY_DELAY_MS = 10 * 60_000

/** Recover missed post-commit publication and deliveries without their consumer receipt. */
export function outboxRecoveryCriteria(owner: string, claimAt: Date, batchSize: number): OutboxClaimCriteria {
  return {
    owner,
    claimAt,
    batchSize,
    recoveryBefore: new Date(claimAt.getTime() - EVENT_RECOVERY_DELAY_MS),
    leaseUntil: new Date(claimAt.getTime() + LEASE_DURATION_MS),
    receiptRecovery: [
      {eventType: "workflow.recalculate", consumer: "recalculation"},
      {eventType: "workflow.status_changed", consumer: "task_generation"},
      {eventType: "task.ready", consumer: "task_dispatch"}
    ]
  }
}
