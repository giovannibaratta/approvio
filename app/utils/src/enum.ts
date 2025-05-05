export function getStringAsEnum<T extends Record<string, string>>(str: string, enumType: T): T[keyof T] | undefined {
  const enumValues = Object.values(enumType)

  if (enumValues.includes(str)) {
    // If it does, we can safely cast the string back to the enum type.
    // This cast is safe because we've just verified the string is one of the enum's values.
    return str as T[keyof T]
  }

  return undefined
}
