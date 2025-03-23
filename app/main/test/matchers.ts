import {ErrorPayload} from "@controllers/error"
import {MatcherFunction} from "expect"

declare global {

  namespace jest {

    interface Matchers<R, T> {
      toHaveErrorCode(expectedCode: string): T
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
    return (
      obj !== null &&
      typeof obj === "object" &&
      typeof obj.code === "string" &&
      typeof obj.message === "string"
    )
  }

  if (!isErrorPayload(received)) {
    return {
      pass: false,
      message: () =>
        `Expected response body to match ErrorPayload structure but got ${JSON.stringify(received)}`
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

expect.extend({
  toHaveErrorCode
})

