import {PkceSessionFactory} from "../src/pkce-session"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"

const metadata = {
  state: "state",
  codeVerifier: "code-verifier",
  redirectUri: "https://example.com/callback",
  oidcState: "oidc-state",
  providerId: "custom",
  createdAt: new Date(0),
  expiresAt: new Date(1000),
  occ: 0n
}
const stepUpTarget = {
  organizationId: "organization-id",
  operation: "admin_action",
  resourceId: "resource-id",
  contextVersion: 1n
}

describe("PkceSessionFactory", () => {
  it.each(["initial_login", "initial_cli_login"])("validates %s", flow => {
    // Given
    const data = {...metadata, flow}

    // When
    const session = unwrapRight(PkceSessionFactory.validate(data))

    // Expect
    expect(session).toMatchObject(data)
    expect(session).not.toHaveProperty("sessionId")
    expect(session).not.toHaveProperty("stepUpTarget")
  })

  it.each(["admin_action", "delete_organization"])("validates step-up for %s", operation => {
    // Given
    const data = {...metadata, flow: "step_up", sessionId: "session-id", stepUpTarget: {...stepUpTarget, operation}}

    // When
    const session = unwrapRight(PkceSessionFactory.validate(data))

    // Expect
    expect(session).toMatchObject(data)
  })

  it.each([
    {data: {flow: "invalid"}, error: "pkce_session_invalid_flow"},
    {data: {flow: "initial_login", sessionId: "session-id"}, error: "pkce_session_unexpected_step_up_context"},
    {data: {flow: "initial_cli_login", stepUpTarget}, error: "pkce_session_unexpected_step_up_context"},
    {data: {flow: "step_up", stepUpTarget}, error: "pkce_session_invalid_session_id"},
    {data: {flow: "step_up", sessionId: "session-id"}, error: "pkce_session_invalid_step_up_target"}
  ])("returns $error for invalid flow context", ({data, error}) => {
    // When
    const result = PkceSessionFactory.validate({...metadata, ...data})

    // Expect
    expect(result).toBeLeftOf(error)
  })

  it.each([
    {patch: {organizationId: undefined}, error: "pkce_session_invalid_organization_id"},
    {patch: {operation: "vote"}, error: "pkce_session_invalid_operation"},
    {patch: {resourceId: undefined}, error: "pkce_session_invalid_resource_id"},
    {patch: {contextVersion: undefined}, error: "pkce_session_invalid_context_version"}
  ])("returns $error for invalid step-up target", ({patch, error}) => {
    // Given
    const data = {...metadata, flow: "step_up", sessionId: "session-id", stepUpTarget: {...stepUpTarget, ...patch}}

    // When
    const result = PkceSessionFactory.validate(data)

    // Expect
    expect(result).toBeLeftOf(error)
  })

  it("validates stored expired and used sessions without deciding whether they can be consumed", () => {
    // Given
    const data = {...metadata, flow: "initial_login", usedAt: new Date(500)}

    // When
    const session = unwrapRight(PkceSessionFactory.validate(data))

    // Expect
    expect(session.expiresAt).toEqual(data.expiresAt)
    expect(session.usedAt).toEqual(data.usedAt)
  })
})
