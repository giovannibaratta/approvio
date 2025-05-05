import {Either, isLeft, isRight} from "fp-ts/lib/Either"

export const unwrapRight = <L, R>(either: Either<L, R>): R => {
  if (isLeft(either)) throw new Error(`Failed to unwrap Either right. Either is left: ${either.left}`)
  return either.right
}

export const unwrapLeft = <L, R>(either: Either<L, R>): L => {
  if (isRight(either)) throw new Error(`Failed to unwrap Either left: Either is right ${either.right}`)
  return either.left
}
