import {randomOrgId} from "@test/organization-id"
import {AgentFactory} from "../src/agent"
import {v7 as uuidv7} from "uuid"

describe("AgentFactory.validate", () => {
  it("validates persisted agent status values", () => {
    const now = new Date()
    expect(
      AgentFactory.validate({
        id: uuidv7(),
        organizationId: randomOrgId(),
        agentName: "Approval agent",
        publicKey: "key",
        status: "invalid",
        roles: [],
        createdAt: now,
        updatedAt: now
      })
    ).toBeLeftOf("agent_invalid_status")
  })
})
