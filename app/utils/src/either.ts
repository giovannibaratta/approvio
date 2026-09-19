import {Either, isLeft, isRight} from "fp-ts/Either"

export function isEither(received: unknown): received is Either<unknown, unknown> {
  const has_tag =
    typeof received === "object" &&
    received !== null &&
    "_tag" in received &&
    typeof received._tag === "string" &&
    (received._tag === "Left" || received._tag === "Right")

  if (!has_tag) return false

  if (received._tag === "Left" && "left" in received) return true
  if (received._tag === "Right" && "right" in received) return true

  return false
}

export const unwrapRight = <L, R>(either: Either<L, R>): R => {
  if (isLeft(either)) throw new Error(`Failed to unwrap Either right. Either is left: ${String(either.left)}`)
  return either.right
}

export const unwrapLeft = <L, R>(either: Either<L, R>): L => {
  if (isRight(either)) throw new Error(`Failed to unwrap Either left: Either is right ${String(either.right)}`)
  return either.left
}
