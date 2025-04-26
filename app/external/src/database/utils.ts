import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {Either} from "fp-ts/Either"

/**
 * Chainable that can be used to convert a non-defined value to a Left value.
 * @param onNullable Left value to return if the value is null or undefined.
 */
export const chainNullableToLeft =
  <L>(onNullable: L) =>
  <A, B>(taskEither: TE.TaskEither<A, B | null | undefined>): TE.TaskEither<A | L, NonNullable<B>> => {
    return pipe(
      taskEither,
      // chainEitherKW applies an Either-returning function to the Right value
      // and automatically widens the Error channel (A | L)
      TE.chainEitherKW(
        // E.fromNullable creates an Either from a potentially nullable value.
        // It takes the error value (or a function returning it) as the first argument.
        // If the value passed to the resulting function is null/undefined, it returns Left(onNullable()).
        // Otherwise, it returns Right(value).
        E.fromNullable(onNullable)
      )
    )
  }

/**
 * Type guard to check if all elements are of type Right
 */
export function areAllRights<A, B>(arr: Array<Either<A, B>>): arr is Array<E.Right<B>> {
  return arr.every(E.isRight)
}
