import {Module} from "@nestjs/common"
import {ConfigModule} from "../config.module"
import {ConfigProvider} from "../config/config-provider"
import {KMS_PROVIDER_TOKEN} from "./kms.provider.interface"
import {EnvVarKmsProvider} from "./env-var-kms.provider"
import {PlatformEncryptionService, TenantEncryptionService} from "./context-bound-encryption.service"

const kmsProvider = {
  provide: KMS_PROVIDER_TOKEN,
  useFactory: (config: ConfigProvider) => {
    if (config.kmsConfig.type === "env_var")
      return new EnvVarKmsProvider(config.kmsConfig.getKeys(), config.kmsConfig.currentVersion)

    throw new Error(`Unsupported KMS provider type: ${String(config.kmsConfig.type)}`)
  },
  inject: [ConfigProvider]
}

@Module({
  imports: [ConfigModule],
  providers: [kmsProvider, TenantEncryptionService, PlatformEncryptionService],
  exports: [kmsProvider, TenantEncryptionService, PlatformEncryptionService]
})
export class KmsModule {}
