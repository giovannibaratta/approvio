import {Module} from "@nestjs/common"
import {APP_GUARD} from "@nestjs/core"
import {PassportModule} from "@nestjs/passport"
import {JwtAuthGuard} from "./jwt.authguard"
import {JwtStrategy} from "./jwt.strategy"
import {ServiceModule} from "@services/service.module"
import {ConfigModule} from "@external/config.module"

@Module({
  imports: [ServiceModule, PassportModule, ConfigModule],
  providers: [
    JwtStrategy,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard
    }
  ],
  exports: []
})
export class AuthModule {}
