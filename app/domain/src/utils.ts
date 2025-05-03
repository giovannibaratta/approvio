const EMAIL_REGEX = new RegExp(
  /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
)

export function hasOwnProperty<T extends object, K extends PropertyKey>(
  obj: T,
  prop: K
): obj is T & Record<K, unknown> {
  return Object.hasOwn(obj, prop)
}

export const isEmail = (value: string): boolean => EMAIL_REGEX.test(value)

export function getStringAsEnumMember<T extends Record<string, string>>(
  str: string,
  enumType: T
): T[keyof T] | undefined {
  const enumValues = Object.values(enumType)

  if (enumValues.includes(str)) {
    // If it does, we can safely cast the string back to the enum type.
    // This cast is safe because we've just verified the string is one of the enum's values.
    return str as T[keyof T]
  }

  return undefined
}
