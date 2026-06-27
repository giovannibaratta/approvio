import {Module, Global} from "@nestjs/common"
import {ConfigModule} from "@external/config.module"
import {ServiceModule} from "@services/service.module"
import {RateLimiterGuard} from "./rate-limiter.guard"
import {HealthRateLimiterGuard} from "./health-rate-limiter.guard"

/**
 * Marked as @Global to guarantee that rate limiting guards (like HealthRateLimiterGuard)
 * are resolved as true application-wide singletons. Without global scoping, separate
 * instantiations occur when imported by multiple modules (e.g. AppModule and ControllersModule),
 * which would break instance-sharing.
 */
@Global()
@Module({
  imports: [ServiceModule, ConfigModule],
  providers: [RateLimiterGuard, HealthRateLimiterGuard],
  exports: [RateLimiterGuard, HealthRateLimiterGuard]
})
export class RateLimiterModule {}
