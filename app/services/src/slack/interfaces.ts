import {TaskEither} from "fp-ts/TaskEither"

export const SLACK_PROVIDER_TOKEN = "SLACK_PROVIDER_TOKEN"

export interface SlackMessage {
  webhookUrl: string
  text: string
}

export type SlackExternalError = "slack_unknown_error" | "slack_request_failed" | "slack_http_timeout"

export interface SlackProviderExternal {
  sendSlackNotification(message: SlackMessage): TaskEither<SlackExternalError, void>
}
