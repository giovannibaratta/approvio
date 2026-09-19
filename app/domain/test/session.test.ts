import {SessionFactory} from "../src/session"
import {unwrapRight} from "@utils/either"
import {isUUIDv7} from "@utils"
import {v7 as uuidv7} from "uuid"
import {toOrganizationId} from "@test/organization-id"
import "@utils/matchers"

describe("SessionFactory", () => {
  const input = () => ({
    accountId: uuidv7(),
    providerId: "custom",
    transport: "browser" as const,
    expiresAt: new Date(Date.now() + 60_000)
  })

  it("creates an active session without a selected organization", () => {
    // Given
    const props = input()
    const beforeCreation = Date.now()

    // When
    const session = unwrapRight(SessionFactory.create(props))

    // Expect
    expect(isUUIDv7(session.id)).toBe(true)
    expect(session).toMatchObject({...props, status: "active", selectedOrganizationId: undefined, contextVersion: 0n})
    expect(session.createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreation)
    expect(session.updatedAt).toEqual(session.createdAt)
  })

  it("rejects invalid or already expired sessions", () => {
    // Expect
    expect(SessionFactory.create({...input(), accountId: "invalid"})).toBeLeftOf("session_invalid_account_id")
    expect(SessionFactory.create({...input(), expiresAt: new Date(0)})).toBeLeftOf("invalid_credential")
    expect(SessionFactory.create({...input(), expiresAt: new Date(NaN)})).toBeLeftOf("invalid_credential")
  })

  it("advances the organization context without changing the persistence version", () => {
    // Given
    const session = {...unwrapRight(SessionFactory.create(input())), occ: 3n}
    const organizationId = toOrganizationId(uuidv7())

    // When
    const switched = unwrapRight(SessionFactory.switchContext(session, organizationId, 3n))

    // Expect
    expect(switched).toMatchObject({selectedOrganizationId: organizationId, contextVersion: 1n, occ: 3n})
    expect(switched.id).toBe(session.id)
    expect(switched.accountId).toBe(session.accountId)
    expect(switched.updatedAt.getTime()).toBeGreaterThanOrEqual(session.updatedAt.getTime())
    expect(session.selectedOrganizationId).toBeUndefined()
    expect(session.contextVersion).toBe(0n)
  })

  it("rejects a stale persistence version", () => {
    // Given
    const session = {...unwrapRight(SessionFactory.create(input())), occ: 3n}

    // Expect
    expect(SessionFactory.switchContext(session, toOrganizationId(uuidv7()), 2n)).toBeLeftOf(
      "organization_context_changed"
    )
  })

  it.each(["revoked", "expired"])("rejects context changes for a %s session", state => {
    // Given
    const created = unwrapRight(SessionFactory.create(input()))
    const invalid = unwrapRight(
      SessionFactory.validate({
        ...created,
        status: state === "revoked" ? "revoked" : "active",
        createdAt: new Date(0),
        updatedAt: new Date(1),
        expiresAt: state === "expired" ? new Date(2) : created.expiresAt
      })
    )

    // Expect
    expect(SessionFactory.switchContext({...invalid, occ: 0n}, toOrganizationId(uuidv7()), 0n)).toBeLeftOf(
      "invalid_credential"
    )
  })
})
