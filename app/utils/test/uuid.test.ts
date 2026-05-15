import {generateDeterministicId} from "@utils/uuid"

describe("generateDeterministicId", () => {
  it("should be deterministic (same input produces same output)", () => {
    const input = "test-input"
    const result1 = generateDeterministicId(input)
    const result2 = generateDeterministicId(input)

    expect(result1).toBe(result2)
  })

  it("should produce different outputs for different inputs", () => {
    const input1 = "test-input-1"
    const input2 = "test-input-2"
    const result1 = generateDeterministicId(input1)
    const result2 = generateDeterministicId(input2)

    expect(result1).not.toBe(result2)
  })

  it("should return a valid UUID v5 format", () => {
    const input = "test-input"
    const result = generateDeterministicId(input)

    // UUID v5 regex: 8-4-5-4-12 hex chars, with version 5
    // xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx where y is [8, 9, a, or b]
    const uuidV5Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(result).toMatch(uuidV5Regex)
  })

  it("should produce a specific known value for a given input", () => {
    const input = "test-input"
    const result = generateDeterministicId(input)

    expect(result).toBe("ebb42086-0a8e-5b54-b223-111044c0e5ab")
  })
})
