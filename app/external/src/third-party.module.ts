import {Module} from "@nestjs/common"
import {ConfigProvider} from "./config/config-provider"
import {EMAIL_EXTERNAL_TOKEN} from "@services"
import {NodemailerEmailProvider} from "./email/email.provider"

const emailProvider = {
  provide: EMAIL_EXTERNAL_TOKEN,
  useClass: NodemailerEmailProvider
}

const providers = [emailProvider]

@Module({
  imports: [],
  providers: [ConfigProvider, ...providers],
  exports: [...providers]
})
export class ThirdPartyModule {}
