import {StepUpReceiptClaim, StepUpReceiptFactory} from "../src/step-up-receipt"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

describe("StepUpReceiptFactory", () => {
  const receipt = {
    organizationId: uuidv7(),
    jti: uuidv7(),
    userId: uuidv7(),
    sessionId: uuidv7(),
    providerId: uuidv7(),
    contextVersion: 1n,
    operation: "vote",
    resourceId: uuidv7(),
    expiresAt: new Date(Date.now() + 60_000),
    status: "unconsumed"
  }

  it("validates and brands the organization ID in a stored receipt", () => {
    expect(StepUpReceiptFactory.validate(receipt)).toBeRight()
  })

  it("rejects an invalid organization ID", () => {
    expect(StepUpReceiptFactory.validate({...receipt, organizationId: "not-a-uuid"})).toBeLeftOf(
      "step_up_receipt_invalid_organization_id"
    )
  })
})

describe("StepUpReceiptFactory.consume", () => {
  const now = new Date("2026-09-30T12:00:00.000Z")
  const receipt = unwrapRight(
    StepUpReceiptFactory.validate({
      organizationId: uuidv7(),
      jti: uuidv7(),
      userId: uuidv7(),
      sessionId: uuidv7(),
      providerId: uuidv7(),
      contextVersion: 1n,
      operation: "vote",
      resourceId: uuidv7(),
      expiresAt: new Date(now.getTime() + 60_000),
      status: "unconsumed"
    })
  )
  const claim: StepUpReceiptClaim = receipt

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("returns the consumed state with its consumption timestamp without mutating the issued receipt", () => {
    const consumed = unwrapRight(StepUpReceiptFactory.consume(receipt, claim))

    expect(consumed).toEqual({...receipt, status: "consumed", consumedAt: now})
    expect(receipt.status).toBe("unconsumed")
  })

  it.each([0, -1])("rejects receipts expiring %i milliseconds from the time of use", offset => {
    const expired = {...receipt, expiresAt: new Date(now.getTime() + offset)}

    expect(StepUpReceiptFactory.consume(expired, claim)).toBeLeftOf("invalid_credential")
  })

  it("rejects an already consumed receipt", () => {
    const consumed = unwrapRight(StepUpReceiptFactory.consume(receipt, claim))

    expect(StepUpReceiptFactory.consume(consumed, claim)).toBeLeftOf("invalid_credential")
  })

  it.each<keyof StepUpReceiptClaim>([
    "organizationId",
    "jti",
    "userId",
    "sessionId",
    "providerId",
    "contextVersion",
    "operation",
    "resourceId"
  ])("rejects a mismatched %s", field => {
    const changedClaim = unwrapRight(
      StepUpReceiptFactory.validate({
        ...receipt,
        [field]: field === "contextVersion" ? 2n : field === "operation" ? "delete_organization" : uuidv7()
      })
    )

    expect(StepUpReceiptFactory.consume(receipt, changedClaim)).toBeLeftOf("invalid_credential")
  })
})
