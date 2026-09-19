import {StepUpOperation} from "./authenticated-entity"
import {TenantContext} from "./shared"

export interface StepUpReceipt extends TenantContext {
  readonly jti: string
  readonly userId: string
  readonly sessionId: string
  readonly providerConnectionId: string
  readonly contextVersion: bigint
  readonly operation: StepUpOperation
  readonly resourceId: string
  readonly expiresAt: Date
}
