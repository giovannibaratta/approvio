import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {bestEffort} from "@utils"

describe("bestEffort", () => {
  it("runs the operation with the successful value and preserves that value", async () => {
    // Given
    const value = {eventId: "event-1"}
    const operation = jest.fn(() => TE.right("published"))
    const onFailure = jest.fn()

    // When
    const result = await pipe(TE.right(value), bestEffort(operation, onFailure))()

    // Expect
    expect(result).toEqual(E.right(value))
    expect(operation).toHaveBeenCalledWith(value)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it("preserves a preceding failure without running or reporting the side effect", async () => {
    // Given
    const operation = jest.fn(() => TE.right(undefined))
    const onFailure = jest.fn()

    // When
    const result = await pipe(TE.left("transaction_failed"), bestEffort(operation, onFailure))()

    // Expect
    expect(result).toEqual(E.left("transaction_failed"))
    expect(operation).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it("reports and suppresses a typed side effect failure", async () => {
    // Given
    const onFailure = jest.fn()

    // When
    const result = await pipe(
      TE.right("committed"),
      bestEffort(() => TE.left("queue_unavailable"), onFailure)
    )()

    // Expect
    expect(result).toEqual(E.right("committed"))
    expect(onFailure).toHaveBeenCalledWith("queue_unavailable", "committed")
  })

  it("propagates an unexpected rejection instead of treating it as a typed failure", async () => {
    // Given
    const onFailure = jest.fn()
    const operation = () => () => Promise.reject(new Error("connection lost"))

    // When
    const result = pipe(TE.right("committed"), bestEffort(operation, onFailure))()

    // Expect
    await expect(result).rejects.toThrow("connection lost")
    expect(onFailure).not.toHaveBeenCalled()
  })

  it("propagates a synchronous exception when constructing the operation", async () => {
    // Given
    const onFailure = jest.fn()
    const operation = (): TE.TaskEither<never, void> => {
      throw new Error("queue initialization failed")
    }

    // When
    const result = pipe(TE.right("committed"), bestEffort(operation, onFailure))()

    // Expect
    await expect(result).rejects.toThrow("queue initialization failed")
    expect(onFailure).not.toHaveBeenCalled()
  })
})
