import {OrganizationId, Versioned} from "./shared"

interface SessionData {
  readonly id: string
  readonly accountId: string
  readonly providerId: string
  /** Null until the account deliberately selects an organization. */
  readonly selectedOrganizationId: OrganizationId | null
  /** Changes whenever the selected browser organization changes. */
  readonly contextVersion: bigint
  /** Optimistic-concurrency version for session mutations. */
  readonly transport: "browser" | "cli"
  readonly expiresAt: Date
}

export type Session = Versioned<SessionData>
