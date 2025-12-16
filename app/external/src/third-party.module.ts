import {Module} from "@nestjs/common"
import {EMAIL_EXTERNAL_TOKEN, OIDC_PROVIDER_TOKEN, HTTP_CLIENT_TOKEN} from "@services"
import {NodemailerEmailProvider} from "./email/email.provider"
import {OidcClient} from "./oidc/oidc.client"
import {OidcBootstrapService} from "./oidc/oidc-bootstrap.service"
import {ConfigModule} from "./config.module"
import {AxiosWebhookClient} from "./webhook/axios-webhook.client"

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

const providers = [emailProvider, oidcProvider, httpClientProvider]

@Module({
  imports: [ConfigModule],
  providers: [...providers, OidcBootstrapService],
  exports: [...providers]
})
export class ThirdPartyModule {}
