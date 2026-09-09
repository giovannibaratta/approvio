import {Actor} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {UnknownError} from "../error"

export const PLATFORM_SECURITY_EVENT_REPOSITORY_TOKEN = Symbol("PLATFORM_SECURITY_EVENT_REPOSITORY_TOKEN")

// TODO: Shouldn't this be placed in the domain ? Also this will likely be a discriminated union to carry
// specialized attributes based on the event I assume. Fine for now if we haven't identified yet an event.
export interface PlatformSecurityEvent {
  readonly id: string
  readonly actor: Actor
  readonly reason: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly occurredAt: Date
}

export interface PlatformSecurityEventRepository {
  append(event: PlatformSecurityEvent): TaskEither<UnknownError, void>
}
