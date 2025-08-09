import {Module} from "@nestjs/common"
import {ConfigProvider} from "./config/config-provider"

@Module({
  imports: [],
  providers: [ConfigProvider],
  exports: [ConfigProvider]
})
export class ConfigModule {}
