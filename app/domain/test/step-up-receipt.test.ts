import {StepUpReceiptClaim, StepUpReceiptFactory} from "../src/step-up-receipt"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

describe("StepUpReceiptFactory", () => {
  const receipt = {
    id: uuidv7(),
    organizationId: uuidv7(),
    jti: uuidv7(),
    userId: uuidv7(),
    sessionId: uuidv7(),
    providerId: "custom",
    contextVersion: 1n,
    operation: "vote",
    resourceId: uuidv7(),
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    consumedAt: null
  }

  it("validates and brands the organization ID in a stored receipt", () => {
    expect(StepUpReceiptFactory.validate(receipt)).toBeRight()
  })

  it("creates an unconsumed receipt with its own identity and creation time", () => {
    // Given
    const validated = StepUpReceiptFactory.validate(receipt)
    const input = unwrapRight(validated)
    const before = new Date()

    // When
    const result = StepUpReceiptFactory.create(input)

    // Expect
    const created = unwrapRight(result)
    expect(created.id).not.toBe(input.id)
    expect(created.jti).toBe(input.jti)
    expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(created.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
    expect(created.consumedAt).toBeNull()
  })

  it.each([
    ["id", "step_up_receipt_invalid_id"],
    ["createdAt", "step_up_receipt_invalid_created_at"],
    ["consumedAt", "step_up_receipt_invalid_consumed_at"]
  ])("rejects an invalid %s", (field, error) => {
    expect(StepUpReceiptFactory.validate({...receipt, [field]: "invalid"})).toBeLeftOf(error)
  })

  it("rejects an invalid organization ID", () => {
    expect(StepUpReceiptFactory.validate({...receipt, organizationId: "not-a-uuid"})).toBeLeftOf(
      "step_up_receipt_invalid_organization_id"
    )
  })
})

describe("StepUpReceiptFactory.consume", () => {
  const now = new Date("2026-09-30T12:00:00.000Z")
  const validated = StepUpReceiptFactory.validate({
    id: uuidv7(),
    organizationId: uuidv7(),
    jti: uuidv7(),
    userId: uuidv7(),
    sessionId: uuidv7(),
    providerId: "custom",
    contextVersion: 1n,
    operation: "vote",
    resourceId: uuidv7(),
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    consumedAt: null
  })
  const receipt = unwrapRight(validated)
  const claim: StepUpReceiptClaim = receipt

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("returns the consumed state with its consumption timestamp without mutating the issued receipt", () => {
    // When
    const result = StepUpReceiptFactory.consume(receipt, claim)

    // Expect
    const consumed = unwrapRight(result)
    expect(consumed).toEqual({...receipt, consumedAt: now})
    expect(receipt.consumedAt).toBeNull()
  })

  it.each([0, -1])("rejects receipts expiring %i milliseconds from the time of use", offset => {
    const expired = {...receipt, expiresAt: new Date(now.getTime() + offset)}

    expect(StepUpReceiptFactory.consume(expired, claim)).toBeLeftOf("invalid_credential")
  })

  it("rejects an already consumed receipt", () => {
    const result = StepUpReceiptFactory.consume(receipt, claim)
    const consumed = unwrapRight(result)

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
    const result = StepUpReceiptFactory.validate({
      ...receipt,
      [field]: field === "contextVersion" ? 2n : field === "operation" ? "delete_organization" : uuidv7()
    })
    const changedClaim = unwrapRight(result)

    expect(StepUpReceiptFactory.consume(receipt, changedClaim)).toBeLeftOf("invalid_credential")
  })
})
