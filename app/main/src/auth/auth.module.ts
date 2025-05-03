import {Module} from "@nestjs/common"
import {APP_GUARD} from "@nestjs/core"
import {JwtModule} from "@nestjs/jwt"
import {PassportModule} from "@nestjs/passport"
import {JwtAuthGuard} from "./jwt.authguard"
import {JwtStrategy} from "./jwt.strategy"
import {ServiceModule} from "@services/service.module"

@Module({
  imports: [
    ServiceModule,
    PassportModule,
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: {expiresIn: "60s"}
    })
  ],
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
