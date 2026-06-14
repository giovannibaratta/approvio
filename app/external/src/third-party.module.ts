import {Module} from "@nestjs/common"
import {
  EMAIL_EXTERNAL_TOKEN,
  OIDC_PROVIDER_TOKEN,
  HTTP_CLIENT_TOKEN,
  SLACK_PROVIDER_TOKEN,
  LEVER_PROVIDER_TOKEN
} from "@services"
import {NodemailerEmailProvider} from "./email/email.provider"
import {OidcClient} from "./oidc/oidc.client"
import {OidcBootstrapService} from "./oidc/oidc-bootstrap.service"
import {ConfigModule} from "./config.module"
import {AxiosWebhookClient} from "./webhook/axios-webhook.client"
import {SlackProvider} from "./slack/slack.provider"
import {OpenFeatureLeverProvider} from "./lever/openfeature-lever.provider"

const emailProvider = {
  provide: EMAIL_EXTERNAL_TOKEN,
  useClass: NodemailerEmailProvider
}

const oidcProvider = {
  provide: OIDC_PROVIDER_TOKEN,
  useClass: OidcClient
}

const httpClientProvider = {
  provide: HTTP_CLIENT_TOKEN,
  useClass: AxiosWebhookClient
}

const slackProvider = {
  provide: SLACK_PROVIDER_TOKEN,
  useClass: SlackProvider
}

const leverProvider = {
  provide: LEVER_PROVIDER_TOKEN,
  useClass: OpenFeatureLeverProvider
}

const providers = [emailProvider, oidcProvider, httpClientProvider, slackProvider, leverProvider]

@Module({
  imports: [ConfigModule],
  providers: [...providers, OidcBootstrapService],
  exports: [...providers]
})
export class ThirdPartyModule {}
