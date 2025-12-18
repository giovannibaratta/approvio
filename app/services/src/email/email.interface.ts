import {PrefixUnion} from "@utils"
import {TaskEither} from "fp-ts/lib/TaskEither"

export type EmailError = PrefixUnion<"email", ServiceError> | EmailExternalError
export type EmailExternalError = PrefixUnion<"email", ExternalError>

type ServiceError = "no_to_specified" | "invalid_from" | "invalid_to"
type ExternalError = "unknown_transient_error" | "unknown_error" | "capability_not_configured"

export interface EmailProviderExternal {
  sendEmail(email: Email): TaskEither<EmailExternalError, void>
}

export interface Email {
  to: string | string[]
  subject?: string
  htmlBody: string
}

export const EMAIL_EXTERNAL_TOKEN = Symbol("EMAIL_EXTERNAL_TOKEN")
