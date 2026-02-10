import {Module} from "@nestjs/common"
import {ControllersModule} from "@controllers/controllers.module"
import {AuthModule} from "./auth/auth.module"
import {RateLimiterModule} from "./rate-limiter/rate-limiter.module"
import {APP_GUARD} from "@nestjs/core"
import {JwtAuthGuard} from "./auth"
import {RateLimiterGuard} from "./rate-limiter"

@Module({
  imports: [ControllersModule, AuthModule, RateLimiterModule],
  controllers: [],
  providers: [
    // Order is import, the JwtAuthGuard must be first to ensure that the user is authenticated before the rate limiter is applied
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard
    },
    {
      provide: APP_GUARD,
      useExisting: RateLimiterGuard
    }
  ]
})
export class AppModule {}
