import {hasOwnProperty} from "@utils"
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

/**
 * Create a union type with a prefix
 * @example
 * type MyUnion = PrefixUnion<"workflow", "name_empty" | "name_too_long"> // "workflow_name_empty" | "workflow_name_too_long"
 */
export type PrefixUnion<TPrefix extends string, TUnion extends string> = `${TPrefix}_${TUnion}`

/**************************
 * Dynamic typing
 *
 * The types defined below allow the user to have functions that return an entity based on the requested
 * properties by the caller. In this case we can have a single entry point to return the same entity
 * but with different facets.
 *
 * For example, we can have a user entity that we can decorate with properties like age, name, etc.
 * We can dynamically request and build the user type with the properties we need.
 **************************/

/** Helper type that allows has to decorate a base entity using the decorators specified by the user.
 * e.g.  we can have a base entity user that we can decorate with properties like age, name, etc.
 * We can dynamically request and build the user type with the properties we need.
 */
type DynamicDecorators<
  AllowedDecorators extends object,
  SelectedDecorators extends Partial<Record<keyof AllowedDecorators, boolean>>
> = {
  // Include in the final type only the keys that are in the both AllowedDecorators and SelectedDecorators
  // and have a value of true.
  [K in keyof AllowedDecorators & keyof SelectedDecorators as SelectedDecorators[K] extends true
    ? K
    : never]: AllowedDecorators[K]
}

/**
 * Helper type that allows has to decorate a base entity using the decorators specified by the user.
 */
export type DecorableEntity<
  BaseEntity,
  AllowedDecorators extends object,
  SelectedDecorators extends Partial<Record<keyof AllowedDecorators, boolean>>
> = BaseEntity & DynamicDecorators<AllowedDecorators, SelectedDecorators>

/** Type guard to validate is a entity has the specified properties */
export function isDecoratedWith<
  TBase extends object,
  TAllowed extends object,
  TSelected extends Partial<Record<keyof TAllowed, boolean>>,
  TKey extends keyof TAllowed
>(
  // The type of entity is not ideal since it's not strict enough but using DecorableEntity<TBase, TAllowed, TSelected>
  // generates a Typescript error. I haven't found a solution yet to narrow the type.
  entity: TBase,
  key: TKey,
  options?: TSelected
): entity is DecorableEntity<TBase, TAllowed, TSelected & Record<TKey, true>> {
  return options !== undefined && options[key] === true && hasOwnProperty(entity, key)
}
