import {Either, left, right} from "fp-ts/lib/Either"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_REGEX = new RegExp(
  /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
)

export const isUUIDv4 = (value: string): boolean => value.match(UUID_REGEX) !== null

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

export function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

export function isDate(value: unknown): value is Date {
  if (typeof value !== "object" || value === null) return false

  return value instanceof Date
}

export function isRecordStringString(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
