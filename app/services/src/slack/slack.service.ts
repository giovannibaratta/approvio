import {Inject, Injectable} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import {SLACK_PROVIDER_TOKEN, SlackExternalError, SlackMessage, SlackProviderExternal} from "./interfaces"

@Injectable()
export class SlackService {
  constructor(
    @Inject(SLACK_PROVIDER_TOKEN)
    private readonly slackProvider: SlackProviderExternal
  ) {}

  sendNotification(message: SlackMessage): TaskEither<SlackExternalError, void> {
    return this.slackProvider.sendSlackNotification(message)
  }
}
