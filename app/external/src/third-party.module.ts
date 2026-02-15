import {Module} from "@nestjs/common"
import {EMAIL_EXTERNAL_TOKEN, OIDC_PROVIDER_TOKEN, HTTP_CLIENT_TOKEN, STEP_UP_TOKEN_REPOSITORY_TOKEN} from "@services"
import {NodemailerEmailProvider} from "./email/email.provider"
import {OidcClient} from "./oidc/oidc.client"
import {OidcBootstrapService} from "./oidc/oidc-bootstrap.service"
import {ConfigModule} from "./config.module"
import {AxiosWebhookClient} from "./webhook/axios-webhook.client"
import {RedisStepUpTokenRepository} from "./auth/step-up-token.provider"

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

const stepUpTokenRepositoryProvider = {
  provide: STEP_UP_TOKEN_REPOSITORY_TOKEN,
  useClass: RedisStepUpTokenRepository
}

const providers = [emailProvider, oidcProvider, httpClientProvider, stepUpTokenRepositoryProvider]

@Module({
  imports: [ConfigModule],
  providers: [...providers, OidcBootstrapService],
  exports: [...providers]
})
export class ThirdPartyModule {}
