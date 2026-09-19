import {randomOrgId} from "@test/organization-id"
import {PlatformSecurityEventFactory} from "../src/platform-security-event"
import {isLeft, isRight} from "fp-ts/Either"
import {v7 as uuidv7} from "uuid"

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

    for (const event of events) expect(isRight(PlatformSecurityEventFactory.validate(event))).toBe(true)
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
