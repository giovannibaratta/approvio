import {MiddlewareConsumer, Module, NestModule} from "@nestjs/common"
import {ControllersModule} from "@controllers/controllers.module"
import {AuthModule} from "./auth/auth.module"
import {RateLimiterModule} from "./rate-limiter/rate-limiter.module"
import {APP_GUARD} from "@nestjs/core"
import {JwtAuthGuard} from "./auth"
import {RateLimiterGuard} from "./rate-limiter"
import {RequestIdMiddleware} from "./logging/request-id.middleware"
import cookieParser from "cookie-parser"
import {LeverMiddleware, LeverGuard} from "./lever"
import {ServiceModule} from "@services/service.module"

@Module({
  imports: [ControllersModule, AuthModule, RateLimiterModule, ServiceModule],
  controllers: [],
  providers: [
    // Order is important, the LeverGuard must run before auth to shed load early
    {
      provide: APP_GUARD,
      useClass: LeverGuard
    },
    // The JwtAuthGuard must be first to ensure that the user is authenticated before the rate limiter is applied
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
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(cookieParser(), RequestIdMiddleware, LeverMiddleware).forRoutes("*")
  }
}
