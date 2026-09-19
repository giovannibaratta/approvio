import {randomOrgId} from "@test/organization-id"
import {PlatformSecurityEventFactory} from "../src/platform-security-event"
import {isLeft} from "fp-ts/Either"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("PlatformSecurityEventFactory", () => {
  const organizationId = randomOrgId()
  const accountId = uuidv7()
  const base = {
    id: uuidv7(),
    actor: {type: "operator" as const, id: uuidv7(), displayName: "Support operator"},
    occurredAt: new Date()
  }

  it("validates each supported operator recovery event", () => {
    const events: unknown[] = [
      {...base, type: "organization.bootstrapped", organizationId, accountId},
      {...base, type: "organization.owner_restored", organizationId, accountId, reason: "owner recovery"},
      {...base, type: "organization.suspended", organizationId, reason: "security"},
      {...base, type: "organization.resumed", organizationId, reason: "incident resolved"},
      {
        ...base,
        type: "organization.grace_period_changed",
        organizationId,
        dueAt: new Date(),
        reason: "payment extension"
      }
    ]

    for (const event of events) {
      const result = PlatformSecurityEventFactory.validate(event)
      expect(result).toBeRightOf(event)
    }
  })

  it.each<{
    name: string
    data: Record<string, unknown>
    metadata: Record<string, unknown>
  }>([
    {
      name: "organization bootstrap",
      data: {type: "organization.bootstrapped", accountId},
      metadata: {organizationId, accountId}
    },
    {
      name: "owner restoration",
      data: {type: "organization.owner_restored", accountId, reason: "owner recovery"},
      metadata: {organizationId, accountId}
    },
    {
      name: "suspension",
      data: {type: "organization.suspended", reason: "security"},
      metadata: {organizationId}
    },
    {
      name: "resumption",
      data: {type: "organization.resumed", reason: "incident resolved"},
      metadata: {organizationId}
    },
    {
      name: "a grace deadline",
      data: {
        type: "organization.grace_period_changed",
        dueAt: new Date("2026-10-17T12:00:00.000Z"),
        reason: "payment extension"
      },
      metadata: {organizationId, dueAt: "2026-10-17T12:00:00.000Z"}
    },
    {
      name: "a cleared grace deadline",
      data: {type: "organization.grace_period_changed", reason: "extension removed"},
      metadata: {organizationId}
    }
  ])("generates metadata for $name", ({data, metadata}) => {
    // Given
    const validated = PlatformSecurityEventFactory.validate({...base, organizationId, ...data})
    const event = unwrapRight(validated)

    // When
    const result = PlatformSecurityEventFactory.toMetadata(event)

    // Expect
    expect(result).toEqual(metadata)
  })

  it("rejects an invalid organization ID", () => {
    // When
    const result = PlatformSecurityEventFactory.validate({
      ...base,
      type: "organization.resumed",
      organizationId: "invalid",
      reason: "incident resolved"
    })

    // Expect
    expect(result).toBeLeftOf("platform_security_event_invalid_organization_id")
  })

  it("requires an account ID for owner restoration", () => {
    // When
    const result = PlatformSecurityEventFactory.validate({
      ...base,
      type: "organization.owner_restored",
      organizationId,
      reason: "owner recovery"
    })

    // Expect
    expect(result).toBeLeftOf("platform_security_event_invalid_account_id")
  })

  it("rejects an invalid grace deadline", () => {
    // When
    const result = PlatformSecurityEventFactory.validate({
      ...base,
      type: "organization.grace_period_changed",
      organizationId,
      dueAt: new Date(NaN),
      reason: "payment extension"
    })

    // Expect
    expect(result).toBeLeftOf("platform_security_event_invalid_due_at")
  })

  it("rejects an unsupported system actor and malformed event data", () => {
    const invalidEvent = {
      ...base,
      type: "organization.resumed",
      organizationId,
      reason: " ",
      actor: {type: "system", displayName: "Workflow worker"}
    }

    expect(isLeft(PlatformSecurityEventFactory.validate(invalidEvent))).toBe(true)
  })
})
