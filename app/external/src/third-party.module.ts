import {Module} from "@nestjs/common"
import {EMAIL_EXTERNAL_TOKEN, OIDC_PROVIDER_TOKEN, HTTP_CLIENT_TOKEN, SLACK_PROVIDER_TOKEN} from "@services"
import {NodemailerEmailProvider} from "./email/email.provider"
import {OidcClient} from "./oidc/oidc.client"
import {OidcBootstrapService} from "./oidc/oidc-bootstrap.service"
import {ConfigModule} from "./config.module"
import {KMS_PROVIDER_TOKEN, EnvVarKmsProvider} from "./kms"
import {ConfigProvider} from "./config/config-provider"
import {AxiosWebhookClient} from "./webhook/axios-webhook.client"
import {SlackProvider} from "./slack/slack.provider"

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

const kmsProvider = {
  provide: KMS_PROVIDER_TOKEN,
  useFactory: (config: ConfigProvider) => {
    if (config.kmsConfig.type === "env_var")
      return new EnvVarKmsProvider(config.kmsConfig.getKeys(), config.kmsConfig.currentVersion)

    throw new Error(`Unsupported KMS provider type: ${config.kmsConfig.type}`)
  },
  inject: [ConfigProvider]
}

const providers = [emailProvider, oidcProvider, httpClientProvider, slackProvider, kmsProvider]

@Module({
  imports: [ConfigModule],
  providers: [...providers, OidcBootstrapService],
  exports: [...providers]
})
export class ThirdPartyModule {}
