import {Module} from "@nestjs/common"
import {EMAIL_EXTERNAL_TOKEN, OIDC_PROVIDER_TOKEN} from "@services"
import {NodemailerEmailProvider} from "./email/email.provider"
import {OidcClient} from "./oidc/oidc.client"
import {OidcBootstrapService} from "./oidc/oidc-bootstrap.service"
import {ConfigModule} from "./config.module"

const emailProvider = {
  provide: EMAIL_EXTERNAL_TOKEN,
  useClass: NodemailerEmailProvider
}

const oidcProvider = {
  provide: OIDC_PROVIDER_TOKEN,
  useClass: OidcClient
}

const providers = [emailProvider, oidcProvider]

@Module({
  imports: [ConfigModule],
  providers: [...providers, OidcBootstrapService],
  exports: [...providers]
})
export class ThirdPartyModule {}
