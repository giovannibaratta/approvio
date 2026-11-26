import {reconstructUsageLedger} from "../src/usage-event"
import {randomOrgId} from "@test/organization-id"
import {generateDeterministicId} from "@utils"
import {v7 as uuidv7} from "uuid"
import * as E from "fp-ts/Either"
import "@utils/matchers"

describe("durable usage ledger reconstruction", () => {
  const organizationId = randomOrgId()
  const operationId = uuidv7()
  const settled = {operationId, estimatedUnits: 10n, state: "settled" as const, actualUnits: 15n}
  const event = {id: generateDeterministicId(`usage-event-${organizationId}-${operationId}`), quantity: 15n}

  it("reconstructs consumption from matching settled operations while retaining reservations", () => {
    // Given
    const reservation = {operationId: uuidv7(), estimatedUnits: 20n, state: "reserved" as const}

    // When
    const result = reconstructUsageLedger(organizationId, [settled, reservation], [event])

    // Expect
    expect(result).toEqual(E.right(15n))
  })

  it.each([
    {scenario: "missing events", events: []},
    {scenario: "wrong quantity", events: [{...event, quantity: 14n}]},
    {scenario: "wrong identity", events: [{...event, id: uuidv7()}]},
    {scenario: "duplicate events", events: [event, event]}
  ])("rejects $scenario", ({events}) => {
    // When
    const result = reconstructUsageLedger(organizationId, [settled], events)

    // Expect
    expect(result).toEqual(E.left("operation_mismatch"))
  })

  it("reconstructs zero consumption for a cancelled operation without a billing event", () => {
    // Given
    const cancelled = {operationId, estimatedUnits: 10n, state: "cancelled" as const}

    // When
    const result = reconstructUsageLedger(organizationId, [cancelled], [])

    // Expect
    expect(result).toBeRightOf(0n)
  })

  it("rejects a billing event for a cancelled operation", () => {
    // Given
    const cancelled = {operationId, estimatedUnits: 10n, state: "cancelled" as const}

    // When
    const result = reconstructUsageLedger(organizationId, [cancelled], [event])

    // Expect
    expect(result).toBeLeftOf("operation_mismatch")
  })

  it("rejects totals outside the storage integer range", () => {
    // Given
    const reservation = {
      operationId: uuidv7(),
      estimatedUnits: 9223372036854775807n,
      state: "reserved" as const
    }

    // When
    const result = reconstructUsageLedger(organizationId, [settled, reservation], [event])

    // Expect
    expect(result).toEqual(E.left("operation_mismatch"))
  })
})
