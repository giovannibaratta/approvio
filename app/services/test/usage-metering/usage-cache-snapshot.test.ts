import "@utils/matchers"
import {UsageSnapshotFactory} from "@services/durable-work/models"
import {UsageCacheSnapshotFactory} from "@services/usage-metering/usage-cache-snapshot"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

const now = new Date("2026-10-24T12:00:00Z")
const hour = 60 * 60 * 1000
const retainUntil = new Date("2027-02-01T00:00:00Z")

describe("UsageCacheSnapshotFactory", () => {
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(now.getTime()))
  afterEach(() => jest.restoreAllMocks())

  it("counts durable reservations and prepares pending-admission holds without expiry", () => {
    // Given
    const operationId = uuidv7()
    const snapshot = unwrapRight(
      UsageSnapshotFactory.validate({
        consumed: 12n,
        operations: [
          {operationId, estimatedUnits: 20n, state: "reserved", expiresAt: new Date(now.getTime() - hour)},
          {operationId: uuidv7(), estimatedUnits: 10n, state: "reserved", expiresAt: new Date(now.getTime() + hour)}
        ]
      })
    )

    // When
    const prepared = UsageCacheSnapshotFactory.create(snapshot, retainUntil)

    // Expect
    expect(prepared.consumed).toBe(12n)
    expect(prepared.reserved).toBe(30n)
    expect(prepared.expiresAt).toBeUndefined()
    expect(prepared.operations[0]).toEqual({
      operationId,
      state: "pending_admission",
      estimatedUnits: 20n,
      admissionExpiresAt: new Date(now.getTime() - hour)
    })
  })

  it("sets completed operation expiry to 48 hours after completion when the deadline has passed", () => {
    // Given
    const expiresAt = new Date(now.getTime() - hour)
    const completedAt = now
    const expected = new Date(now.getTime() + 48 * hour)
    const settledId = uuidv7()
    const cancelledId = uuidv7()
    const snapshot = unwrapRight(
      UsageSnapshotFactory.validate({
        consumed: 12n,
        operations: [
          {operationId: settledId, estimatedUnits: 20n, state: "settled", actualUnits: 12n, expiresAt, completedAt},
          {operationId: cancelledId, estimatedUnits: 5n, state: "cancelled", expiresAt, completedAt}
        ]
      })
    )

    // When
    const prepared = UsageCacheSnapshotFactory.create(snapshot, retainUntil)

    // Expect
    expect(prepared.reserved).toBe(0n)
    expect(prepared.operations).toEqual([
      {
        operationId: settledId,
        state: "settled",
        estimatedUnits: 20n,
        actualUnits: 12n,
        admissionExpiresAt: expiresAt,
        expiresAt: expected
      },
      {
        operationId: cancelledId,
        state: "cancelled",
        estimatedUnits: 5n,
        admissionExpiresAt: expiresAt,
        expiresAt: expected
      }
    ])
  })

  it("sets completed operation expiry to 48 hours after a future admission deadline", () => {
    // Given
    const expiresAt = new Date(now.getTime() + hour)
    const completedAt = now
    const expected = new Date(now.getTime() + 49 * hour)
    const settledId = uuidv7()
    const cancelledId = uuidv7()
    const snapshot = unwrapRight(
      UsageSnapshotFactory.validate({
        consumed: 12n,
        operations: [
          {operationId: settledId, estimatedUnits: 20n, state: "settled", actualUnits: 12n, expiresAt, completedAt},
          {operationId: cancelledId, estimatedUnits: 5n, state: "cancelled", expiresAt, completedAt}
        ]
      })
    )

    // When
    const prepared = UsageCacheSnapshotFactory.create(snapshot, retainUntil)

    // Expect
    expect(prepared.reserved).toBe(0n)
    expect(prepared.operations).toEqual([
      {
        operationId: settledId,
        state: "settled",
        estimatedUnits: 20n,
        actualUnits: 12n,
        admissionExpiresAt: expiresAt,
        expiresAt: expected
      },
      {
        operationId: cancelledId,
        state: "cancelled",
        estimatedUnits: 5n,
        admissionExpiresAt: expiresAt,
        expiresAt: expected
      }
    ])
  })

  it("omits expired completed fields while retaining all consumed usage", () => {
    // Given
    const expiresAt = new Date(now.getTime() - 72 * hour)
    const snapshot = unwrapRight(
      UsageSnapshotFactory.validate({
        consumed: 12n,
        operations: [
          {
            operationId: uuidv7(),
            estimatedUnits: 20n,
            state: "settled",
            actualUnits: 12n,
            expiresAt,
            completedAt: expiresAt
          }
        ]
      })
    )

    // When
    const prepared = UsageCacheSnapshotFactory.create(snapshot, retainUntil)

    // Expect
    expect(prepared.consumed).toBe(12n)
    expect(prepared.reserved).toBe(0n)
    expect(prepared.operations).toEqual([])
  })

  it("rejects durable operations without a start deadline", () => {
    // Given
    const snapshot = {
      consumed: 12n,
      operations: [{operationId: uuidv7(), estimatedUnits: 20n, state: "settled", actualUnits: 12n}]
    }
    // When
    const result = UsageSnapshotFactory.validate(snapshot)
    // Expect
    expect(result).toBeLeftOf("invalid_operation_expires_at")
  })

  it("keeps an empty replacement for at least another day", () => {
    // Given
    const snapshot = unwrapRight(UsageSnapshotFactory.validate({consumed: 0n, operations: []}))

    // When
    const prepared = UsageCacheSnapshotFactory.create(snapshot, new Date(0))

    // Expect
    expect(prepared.expiresAt).toEqual(new Date(now.getTime() + 24 * hour))
  })
})
