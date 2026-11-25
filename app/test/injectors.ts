import {jest} from "@jest/globals"
import type {MethodLikeKeys} from "jest-mock"
import * as E from "fp-ts/Either"

type Task<A> = () => Promise<A>

/**
 * Awaits the observer with the original arguments before invoking the wrapped method.
 * The returned array collects observations as the returned tasks run.
 */
export function observeTaskEither<
  T extends object,
  M extends MethodLikeKeys<T>,
  V,
  F extends (...args: never[]) => Task<unknown> = T[M] extends (...args: never[]) => Task<unknown> ? T[M] : never
>(obj: T, methodName: M, observe: (...args: Parameters<F>) => Promise<V>): V[] {
  const spy = jest.spyOn(obj, methodName)
  const original = spy.getMockImplementation() ?? obj[methodName]

  if (typeof original !== "function") throw new Error(`Property ${String(methodName)} is not a function.`)
  const bound = original.bind(obj)

  const observations: V[] = []
  spy.mockImplementation((...args: Parameters<F>) => async () => {
    observations.push(await observe(...args))
    return bound(...args)()
  })

  return observations
}

/**
 * Replaces the method with a task that resolves to Right(value) when run.
 * Returns the Jest spy for assertions or restoration.
 */
export function succeedTaskEither<
  T extends object,
  M extends MethodLikeKeys<T>,
  F extends (...args: never[]) => Task<unknown> = T[M] extends (...args: never[]) => Task<unknown> ? T[M] : never
>(obj: T, methodName: M, value: unknown): jest.SpiedFunction<F> {
  return jest.spyOn(obj, methodName).mockImplementation(() => () => Promise.resolve(E.right(value)))
}

/**
 * Replaces the method with a task that rejects when run to simulate an unexpected exception.
 * Returns the Jest spy for assertions or restoration.
 */
export function rejectTaskEither<
  T extends object,
  M extends MethodLikeKeys<T>,
  F extends (...args: never[]) => Task<unknown> = T[M] extends (...args: never[]) => Task<unknown> ? T[M] : never
>(obj: T, methodName: M, error: Error): jest.SpiedFunction<F> {
  return jest.spyOn(obj, methodName).mockImplementation(() => () => Promise.reject(error))
}

/**
 * Runs the original task and preserves its side effects.
 * Passes through an existing Left or a rejection and replaces a Right with Left(error).
 * Returns the Jest spy for assertions or restoration.
 */
export function failTaskEitherAfterSuccess<
  T extends object,
  M extends MethodLikeKeys<T>,
  F extends (...args: never[]) => Task<unknown> = T[M] extends (...args: never[]) => Task<unknown> ? T[M] : never
>(obj: T, methodName: M, error: unknown): jest.SpiedFunction<F> {
  const spy = jest.spyOn(obj, methodName)
  const original = spy.getMockImplementation() ?? obj[methodName]

  if (typeof original !== "function") throw new Error(`Property ${String(methodName)} is not a function.`)
  const bound = original.bind(obj)

  return spy.mockImplementation((...args: Parameters<F>) => async () => {
    const result = await bound(...args)()
    return E.isLeft(result) ? result : E.left(error)
  })
}

/**
 * Wraps a method on an object with a side effect.
 *
 * It will use jest.spyOn to intercept the method call. It executes the original method
 * and gets the result. Before returning the result, it awaits the execution of the side effect.
 * This is particularly useful for simulating race conditions in tests.
 *
 * @param obj The object containing the method to intercept.
 * @param methodName The name of the method to intercept.
 * @param sideEffect A function returning a Promise that will be executed after the original method but before it returns.
 */
export function wrapWithSideEffect<
  T extends object,
  M extends MethodLikeKeys<T>,
  F extends (...args: never[]) => Promise<unknown> = T[M] extends (...args: never[]) => Promise<unknown> ? T[M] : never
>(obj: T, methodName: M, sideEffect: (...args: Parameters<F>) => Promise<void>): jest.SpiedFunction<F> {
  const spy = jest.spyOn(obj, methodName)

  const originalImpl = spy.getMockImplementation() ?? obj[methodName]

  if (typeof originalImpl !== "function") throw new Error(`Property ${String(methodName)} is not a function.`)

  // Bind the original method to the object so 'this' works correctly if used inside the original method
  const boundOriginal = originalImpl.bind(obj)

  return spy.mockImplementation(async (...args: Parameters<F>) => {
    // 1. Execute original method
    const result = await boundOriginal(...args)
    // 2. Execute side effect (simulating a race condition or concurrent operation)
    // Pass original arguments to allow conditional side effects
    await sideEffect(...args)
    // 3. Return the original result
    return result
  })
}

/**
 * Wraps a method returning a TaskEither on an object with a side effect.
 *
 * It will use jest.spyOn to intercept the method call. It executes the original method
 * and gets the result. Before returning the result, it awaits the execution of the side effect.
 * This is particularly useful for simulating race conditions in tests.
 *
 * @param obj The object containing the method to intercept.
 * @param methodName The name of the method to intercept.
 * @param sideEffect A function returning a Promise that will be executed after the original method but before it returns.
 */
export function wrapTaskEitherWithSideEffect<
  T extends object,
  M extends MethodLikeKeys<T>,
  F extends (...args: never[]) => Task<unknown> = T[M] extends (...args: never[]) => Task<unknown> ? T[M] : never
>(obj: T, methodName: M, sideEffect: (...args: Parameters<F>) => Promise<void>): jest.SpiedFunction<F> {
  const spy = jest.spyOn(obj, methodName)

  const originalImpl = spy.getMockImplementation() ?? obj[methodName]

  if (typeof originalImpl !== "function") throw new Error(`Property ${String(methodName)} is not a function.`)

  // Bind the original method to the object so 'this' works correctly if used inside the original method
  const boundOriginal = originalImpl.bind(obj)

  return spy.mockImplementation((...args: Parameters<F>) => {
    return async () => {
      // 1. Execute original method
      const taskEither = boundOriginal(...args)
      const result = await taskEither()

      // 2. Execute side effect (simulating a race condition or concurrent operation)
      // Pass original arguments to allow conditional side effects
      await sideEffect(...args)

      // 3. Return the original result
      return result
    }
  })
}

/**
 * Forces a method returning a TaskEither to fail with a specific error.
 *
 * @param obj The object containing the method to intercept.
 * @param methodName The name of the method to intercept.
 * @param error The error to return in the Left side of the TaskEither.
 */
export function failTaskEither<
  T extends object,
  M extends MethodLikeKeys<T>,
  F extends (...args: never[]) => Task<unknown> = T[M] extends (...args: never[]) => Task<unknown> ? T[M] : never
>(obj: T, methodName: M, error: unknown): jest.SpiedFunction<F> {
  const spy = jest.spyOn(obj, methodName)

  return spy.mockImplementation(() => {
    return () => {
      return Promise.resolve(E.left(error))
    }
  })
}
