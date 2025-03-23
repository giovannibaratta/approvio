export interface ErrorPayload {
  message: string
  code: string
}

export function generateErrorPayload(code: string, message: string): ErrorPayload {
  if (code.trim().length < 0) {
    throw Error("Code can not be an empty string")
  }

  return {
    message,
    code
  }
}
