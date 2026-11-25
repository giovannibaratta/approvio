import {UsageCacheOperationFactory} from "@services/usage-metering/usage-cache-operation"
import {UsageSettlementResultFactory} from "@services/durable-work/models"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

const now = new Date("2026-10-24T12:00:00Z")
const hour = 60 * 60 * 1000

describe("UsageCacheOperationFactory", () => {
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(now.getTime()))
  afterEach(() => jest.restoreAllMocks())

  it("keeps reservation identity and quantity typed without converting the quantity to a number", () => {
    // Given
    const operationId = uuidv7()
    const expiresAt = new Date(now.getTime() + hour)

    // When
    const operation = UsageCacheOperationFactory.reserve(operationId, "UNLIMITED", 9007199254740993n, expiresAt)

    // Expect
    expect(operation).toEqual({
      operationId,
      state: "reserved",
      limit: "UNLIMITED",
      estimatedUnits: 9007199254740993n,
      admissionExpiresAt: expiresAt
    })
  })

  it("prepares a typed settled operation with the two different retention deadlines", () => {
    // Given
    const operationId = uuidv7()
    const expiresAt = new Date(now.getTime() + hour)
    const result = unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 12n}))

    // When
    const prepared = UsageCacheOperationFactory.settle(operationId, 20n, result, expiresAt)

    // Expect
    expect(prepared.operation).toEqual({
      operationId,
      state: "settled",
      estimatedUnits: 20n,
      actualUnits: 12n,
      admissionExpiresAt: expiresAt,
      expiresAt: new Date(now.getTime() + 49 * hour)
    })
    expect(prepared.replayWindowEndsAt).toEqual(new Date(now.getTime() + 49 * hour))
    expect(prepared.operation.expiresAt).toEqual(new Date(now.getTime() + 49 * hour))
    expect(prepared.minimumCacheExpiresAt).toEqual(new Date(now.getTime() + 24 * hour))
  })

  it("retains a late cancellation for 48 hours without extending the admission replay window", () => {
    // Given
    const result = unwrapRight(UsageSettlementResultFactory.validate({state: "cancelled"}))
    const expiresAt = new Date(now.getTime() - 72 * hour)

    // When
    const prepared = UsageCacheOperationFactory.settle(uuidv7(), 20n, result, expiresAt)

    // Expect
    expect(prepared.operation.state).toBe("cancelled")
    expect(prepared.replayWindowEndsAt).toEqual(new Date(now.getTime() - 24 * hour))
    expect(prepared.operation.expiresAt).toEqual(new Date(now.getTime() + 48 * hour))
  })

  it("keeps completed usage quantities above the safe integer range exact", () => {
    // Given
    const operationId = uuidv7()
    const result = unwrapRight(
      UsageSettlementResultFactory.validate({
        state: "settled",
        actualUnits: 9007199254740993n
      })
    )

    // When
    const prepared = UsageCacheOperationFactory.settle(
      operationId,
      9007199254740994n,
      result,
      new Date(now.getTime() + hour)
    )

    // Expect
    expect(prepared.operation).toMatchObject({
      operationId,
      state: "settled",
      estimatedUnits: 9007199254740994n,
      actualUnits: 9007199254740993n
    })
  })
})
