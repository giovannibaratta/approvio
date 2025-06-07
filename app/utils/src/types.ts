import {TaskEither} from "fp-ts/TaskEither"

/**
 * Extracts the Left type from the TaskEither return type of a specific class method.
 * @template ClassType The class constructor type.
 * @template MethodName The name of the method on the class instance.
 */
export type ExtractLeftFromMethod<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ClassType extends new (...args: any[]) => any, // Constraint: ensure it's a constructor
  MethodName extends keyof InstanceType<ClassType> // Constraint: ensure MethodName is a key of the instance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
> = ExtractReturnType<ClassType, MethodName> extends TaskEither<infer E, any> ? E : never

/**
 * Extracts the return type of a method on a class instance.
 * @template ClassType The class constructor type.
 * @template MethodName The name of the method on the class instance.
 */
type ExtractReturnType<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ClassType extends new (...args: any[]) => any, // Constraint: ensure it's a constructor
  MethodName extends keyof InstanceType<ClassType> // Constraint: ensure MethodName is a key of the instance
> =
  // Get the return type of the specified method
  ReturnType<InstanceType<ClassType>[MethodName]>

/**
 * Omit a key from a union type preserving the type of the union
 * @example
 * type MyUnion = {a: string, c: number} | {b: number, c: string}
 * type MyUnionWithoutC = DistributiveOmit<MyUnion, "c"> // {a: string} | {b: number}
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never
