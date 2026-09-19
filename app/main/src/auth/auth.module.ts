import {Module} from "@nestjs/common"
import {PassportModule} from "@nestjs/passport"
import {JwtStrategy} from "./jwt.strategy"
import {ServiceModule} from "@services/service.module"
import {ConfigModule} from "@external/config.module"

@Module({
  imports: [ServiceModule.register({runtime: "api"}), PassportModule, ConfigModule],
  providers: [JwtStrategy],
  exports: []
})
export class AuthModule {}
