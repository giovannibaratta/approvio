import {Injectable, Logger} from "@nestjs/common"
import axios from "axios"
import {TaskEither, tryCatch} from "fp-ts/lib/TaskEither"
import {SlackExternalError, SlackMessage, SlackProviderExternal} from "@services/slack/interfaces"

@Injectable()
export class SlackProvider implements SlackProviderExternal {
  // Using axios instead of @slack/webhook to avoid introducing extra external dependencies
  // and to have fine-grained control over request configurations like timeouts.
  sendSlackNotification(message: SlackMessage): TaskEither<SlackExternalError, void> {
    return tryCatch(
      async () => {
        const payload: {text: string} = {
          text: message.text
        }

        await axios.post(message.webhookUrl, payload, {
          timeout: 5000,
          headers: {
            "Content-Type": "application/json"
          }
        })
        Logger.log("Successfully sent Slack notification")
      },
      reason => {
        if (axios.isAxiosError(reason)) {
          if (reason.code === "ECONNABORTED") {
            Logger.error(`Slack notification timed out: ${reason.message}`)
            return "slack_http_timeout"
          }
          Logger.error(`Failed to send Slack notification: ${reason.message}`)
          return "slack_request_failed"
        }

        const errorMessage = reason instanceof Error ? reason.message : String(reason)
        Logger.error(`Failed to send Slack notification due to non-Axios error: ${errorMessage}`)
        return "slack_unknown_error"
      }
    )
  }
}
