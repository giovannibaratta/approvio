import {Either, left, right} from "fp-ts/Either"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL_REGEX = new RegExp(
  /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
)

export const isUUIDv7 = (value: string): boolean => value.match(UUID_REGEX) !== null

export const isEmail = (value: string): boolean => EMAIL_REGEX.test(value)

export function hasOwnProperty<T extends object, K extends PropertyKey>(
  obj: T,
  prop: K
): obj is T & Record<K, unknown> {
  return Object.hasOwn(obj, prop)
}

export function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val)
}

export function isDate(value: unknown): value is Date {
  if (typeof value !== "object" || value === null) return false

  return value instanceof Date
}

export function isRecordStringString(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false

  return Object.values(value).every(v => typeof v === "string")
}

export function eitherParseInt<T>(value: unknown, leftValue: T, base: number = 10): Either<T, number> {
  if (typeof value !== "string") return left(leftValue)
  const parsed = parseInt(value, base)
  return isNaN(parsed) ? left(leftValue) : right(parsed)
}

export function eitherParseOptionalBoolean<T>(value: unknown, leftValue: T): Either<T, boolean | undefined> {
  if (value === undefined) return right(undefined)
  if (typeof value !== "string" && typeof value !== "boolean") return left(leftValue)
  if (typeof value === "boolean") return right(value)

  const sanitized = value.toLocaleLowerCase().trim()

  if (sanitized !== "true" && sanitized !== "false") return left(leftValue)
  return right(sanitized === "true")
}

/**
 * Validates if a given string is an HTTP or HTTPS URL.
 *
 * @param url - The URL string to validate.
 * @returns True if the URL is valid and uses http or https protocol, false otherwise.
 */
export function isValidHttpOrHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}
