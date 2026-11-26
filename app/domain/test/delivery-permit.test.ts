import {DeliveryPermitFactory, DeliveryPermitValidationError} from "@domain"
import {unwrapRight} from "@utils/either"

describe("DeliveryPermitFactory", () => {
  const data = {owner: "execution-id", fencing: 3n, expiresAt: new Date(0)}

  it("validates the token structure while leaving current ownership to the limiter", () => {
    // Given: structural validation also accepts expired tokens for ownership checks.
    // When
    const result = DeliveryPermitFactory.validate(data)
    // Expect
    expect(unwrapRight(result)).toEqual(data)
  })

  const invalidInputs: ReadonlyArray<{input: unknown; error: DeliveryPermitValidationError}> = [
    {input: undefined, error: "delivery_permit_malformed_object"},
    {input: {}, error: "delivery_permit_invalid_owner"},
    {input: {...data, owner: " "}, error: "delivery_permit_invalid_owner"},
    {input: {...data, owner: 1}, error: "delivery_permit_invalid_owner"},
    {input: {...data, fencing: 3}, error: "delivery_permit_invalid_fencing"},
    {input: {...data, fencing: "3"}, error: "delivery_permit_invalid_fencing"},
    {input: {...data, expiresAt: 0}, error: "delivery_permit_invalid_expires_at"},
    {input: {...data, expiresAt: new Date(NaN)}, error: "delivery_permit_invalid_expires_at"}
  ]

  it.each(invalidInputs)("returns $error for invalid token data", ({input, error}) => {
    // Given / When
    const result = DeliveryPermitFactory.validate(input)
    // Expect
    expect(result).toBeLeftOf(error)
  })
})
