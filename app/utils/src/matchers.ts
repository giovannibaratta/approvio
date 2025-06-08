import {ErrorPayload} from "@controllers/error"
// eslint-disable-next-line node/no-extraneous-import
import {MatcherFunction} from "expect"
import {Either, isLeft, isRight} from "fp-ts/lib/Either"

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toHaveErrorCode(expectedCode: string): R
      /**
       * Asserts that the response has the expected HTTP status code.
       * If the status code differs, the response body is printed in the error message.
       * @param expectedStatusCode The expected HTTP status code (e.g., 200, 404).
       */
      toHaveStatusCode(expectedStatusCode: number): R
      toBeLeft(): R
      toBeLeftOf(expected: unknown): R
      toBeRight(): R
    }

    interface ExpectExtendMap {
      toHaveErrorCode: MatcherFunction<[expectedCode: string]>
      toBeLeft: MatcherFunction<[]>
      toBeLeftOf: MatcherFunction<[expected: unknown]>
      toBeRight: MatcherFunction<[]>
    }
  }
}

export {}

function isEither(received: unknown): received is Either<unknown, unknown> {
  const has_tag =
    typeof received === "object" &&
    received !== null &&
    "_tag" in received &&
    typeof received._tag === "string" &&
    (received._tag === "Left" || received._tag === "Right")

  if (!has_tag) return false

  if (received._tag === "Left" && "left" in received) return true
  if (received._tag === "Right" && "right" in received) return true

  return false
}

export function toBeLeft(received: unknown): jest.CustomMatcherResult {
  if (!isEither(received)) {
    return {
      pass: false,
      message: () => `Expected ${received} to be an Either`
    }
  }

  return {
    pass: isLeft(received),
    message: () => `Expected ${received} to be left`
  }
}

export function toBeLeftOf(received: unknown, expected: unknown): jest.CustomMatcherResult {
  if (!isEither(received)) {
    return {
      pass: false,
      message: () => `Expected ${received} to be an Either`
    }
  }

  if (!isLeft(received)) {
    return {
      pass: false,
      message: () => `Expected ${received} to be left`
    }
  }

  const pass = received.left === expected

  return {
    pass,
    message: () => `Expected ${received} to be left of ${expected}`
  }
}

export function toBeRight(received: unknown): jest.CustomMatcherResult {
  if (!isEither(received)) {
    return {
      pass: false,
      message: () => `Expected ${received} to be an Either`
    }
  }

  if (!isRight(received)) {
    return {
      pass: false,
      message: () => `Expected ${received} to be right`
    }
  }

  return {
    pass: true,
    message: () => `Expected ${received} to be right`
  }
}

export function toHaveErrorCode(received: unknown, expectedCode: string): jest.CustomMatcherResult {
  // Type guard function to validate ErrorPayload structure
  const isErrorPayload = (obj: unknown): obj is ErrorPayload => {
    return (
      obj !== null &&
      typeof obj === "object" &&
      hasOwnProperty(obj, "code") &&
      typeof obj.code === "string" &&
      hasOwnProperty(obj, "message") &&
      typeof obj.message === "string"
    )
  }

  if (!isErrorPayload(received)) {
    return {
      pass: false,
      message: () => `Expected response body to match ErrorPayload structure but got ${JSON.stringify(received)}`
    }
  }

  const pass = received.code === expectedCode

  return {
    pass,
    message: () =>
      pass
        ? `Expected response not to have error code "${expectedCode}"`
        : `Expected response to have error code "${expectedCode}" but got "${received.code}"`
  }
}

/**
 * Custom Jest matcher implementation for checking HTTP status codes.
 * @param this Jest's matcher context.
 * @param actualResponse The actual response object from the test.
 * @param expectedStatusCode The expected HTTP status code.
 * @returns Jest MatcherResult object.
 */
export function toHaveStatusCode(
  this: jest.MatcherContext,
  actualResponse: unknown,
  expectedStatusCode: number
): jest.CustomMatcherResult {
  if (typeof actualResponse !== "object" || actualResponse === null) {
    return {
      pass: false,
      message: () => "Expected response object to be an object, but it was not."
    }
  }

  if (!hasOwnProperty(actualResponse, "statusCode")) {
    return {
      pass: false,
      message: () => "Expected response object to have a 'statusCode' property."
    }
  }

  if (typeof actualResponse.statusCode !== "number") {
    return {
      pass: false,
      message: () => "Expected response object to have a 'statusCode' property of type number."
    }
  }

  if (!hasOwnProperty(actualResponse, "body")) {
    return {
      pass: false,
      message: () => "Expected response object to have a 'body' property."
    }
  }

  if (typeof actualResponse.body !== "object" || actualResponse.body === null) {
    return {
      pass: false,
      message: () =>
        "Expected response object to have a 'body' property of type object, but it was missing or undefined."
    }
  }

  // Determine if the response object has a 'statusCode' property.
  const actualStatusCode = actualResponse?.statusCode
  const actualBody = actualResponse?.body

  // Check if the actual response object or its status code is missing
  if (actualStatusCode === undefined) {
    return {
      pass: false,
      message: () => "Expected response object to have a 'statusCode' property, but it was missing or undefined."
    }
  }

  // Check if the status codes match
  const pass = actualStatusCode === expectedStatusCode

  // Construct the failure message if the status codes do not match
  if (!pass) {
    const message = () =>
      `${this.utils.matcherHint(".toHaveStatusCode")}\n\n` +
      `Expected status code: ${this.utils.printExpected(expectedStatusCode)}\n` +
      `Received status code: ${this.utils.printReceived(actualStatusCode)}\n` +
      (actualBody !== undefined ? `Response Body:\n${this.utils.printReceived(actualBody)}` : "No response body found.")

    return {pass: false, message}
  }

  return {
    pass: true,
    message: () =>
      `${this.utils.matcherHint(".not.toHaveStatusCode")}\n\n` +
      `Expected status code not to be: ${this.utils.printExpected(expectedStatusCode)}\n` +
      `Received status code: ${this.utils.printReceived(actualStatusCode)}`
  }
}

expect.extend({
  toHaveErrorCode,
  toHaveStatusCode,
  toBeLeft,
  toBeLeftOf,
  toBeRight
})

function hasOwnProperty<T extends object, K extends PropertyKey>(obj: T, prop: K): obj is T & Record<K, unknown> {
  return prop in obj
}
