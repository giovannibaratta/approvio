import {toOrganizationId} from "@test/organization-id"
import {AccountRefreshTokenFactory, AgentRefreshTokenFactory, RefreshTokenStatus, canTokenBeRefreshed} from "@domain"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"

const accountId = "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e61"
const sessionId = "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e62"
const providerId = "custom"
const organizationId = toOrganizationId("018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e64")
const agentId = "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e65"
const tokenId = "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e66"
const familyId = "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e67"

describe("refresh-token boundaries", () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z")
  const expiresAt = new Date("2026-02-01T00:00:00.000Z")

  it("accepts a deployment provider key on an account refresh token", () => {
    // Given
    const input = {
      entityType: "account",
      id: tokenId,
      tokenHash: "hash",
      familyId,
      accountId,
      sessionId,
      providerId,
      status: RefreshTokenStatus.ACTIVE,
      createdAt,
      expiresAt
    }

    // When
    const result = AccountRefreshTokenFactory.validate(input)

    // Expect
    expect(result).toBeRightOf(expect.objectContaining({providerId: "custom"}))
  })

  it.each(["", " "])("rejects an empty provider key (%j)", invalidProviderId => {
    // Given
    const input = {
      entityType: "account",
      id: tokenId,
      tokenHash: "hash",
      familyId,
      accountId,
      sessionId,
      providerId: invalidProviderId,
      status: RefreshTokenStatus.ACTIVE,
      createdAt,
      expiresAt
    }

    // When
    const result = AccountRefreshTokenFactory.validate(input)

    // Expect
    expect(result).toBeLeftOf("refresh_token_invalid_provider_id")
  })

  it("requires complete platform account/session/provider binding", () => {
    const result = AccountRefreshTokenFactory.validate({
      entityType: "account",
      id: tokenId,
      tokenHash: "hash",
      familyId,
      accountId,
      providerId,
      status: RefreshTokenStatus.ACTIVE,
      createdAt,
      expiresAt
    })

    expect(result).toBeLeftOf("refresh_token_invalid_session_id")
  })

  it("requires the tenant organization on an agent token", () => {
    const result = AgentRefreshTokenFactory.validate({
      entityType: "agent",
      id: tokenId,
      tokenHash: "hash",
      familyId,
      agentId,
      status: RefreshTokenStatus.ACTIVE,
      createdAt,
      expiresAt
    })

    expect(result).toBeLeftOf("refresh_token_invalid_organization_id")
  })

  it("keeps an agent token bound to organization and immutable agent UUID", () => {
    const result = AgentRefreshTokenFactory.validate({
      entityType: "agent",
      id: tokenId,
      organizationId,
      agentId,
      tokenHash: "hash",
      familyId,
      status: RefreshTokenStatus.ACTIVE,
      createdAt,
      expiresAt
    })

    expect(result).toBeRightOf(expect.objectContaining({organizationId, agentId}))
  })

  it("detects reuse outside the rotation grace period", () => {
    const token = AgentRefreshTokenFactory.validate({
      entityType: "agent",
      id: tokenId,
      organizationId,
      agentId,
      tokenHash: "hash",
      familyId,
      status: RefreshTokenStatus.USED,
      usedAt: new Date("2026-01-01T00:00:01.000Z"),
      nextTokenId: sessionId,
      createdAt,
      expiresAt
    })
    const result = pipe(
      token,
      E.chainW(value => canTokenBeRefreshed(value, new Date("2026-01-01T00:01:00.000Z")))
    )
    expect(result).toBeLeftOf("refresh_token_reuse_detected")
  })
})
