import {ErrorPayload} from "@controllers/error"
import {MatcherFunction} from "expect"

declare global {
  namespace jest {
    interface Matchers<R, T> {
      toHaveErrorCode(expectedCode: string): T
      /**
       * Asserts that the response has the expected HTTP status code.
       * If the status code differs, the response body is printed in the error message.
       * @param expectedStatusCode The expected HTTP status code (e.g., 200, 404).
       */
      toHaveStatusCode(expectedStatusCode: number): R
    }

    interface ExpectExtendMap {
      toHaveErrorCode: MatcherFunction<[expectedCode: string]>
    }
  }
}

export {}

export function toHaveErrorCode(received: unknown, expectedCode: string) {
  // Type guard function to validate ErrorPayload structure
  const isErrorPayload = (obj: any): obj is ErrorPayload => {
    return obj !== null && typeof obj === "object" && typeof obj.code === "string" && typeof obj.message === "string"
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
  actualResponse: any,
  expectedStatusCode: number
): jest.CustomMatcherResult {
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
  toHaveStatusCode
})
