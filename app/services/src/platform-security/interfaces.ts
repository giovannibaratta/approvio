import {PlatformSecurityEvent} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {UnknownError} from "../error"

export const PLATFORM_SECURITY_EVENT_REPOSITORY_TOKEN = Symbol("PLATFORM_SECURITY_EVENT_REPOSITORY_TOKEN")

export interface PlatformSecurityEventRepository {
  append(event: PlatformSecurityEvent): TaskEither<UnknownError, void>
}
