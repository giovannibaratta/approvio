import {Module} from "@nestjs/common"
import {ConfigModule} from "@external/config.module"
import {ServiceModule} from "@services/service.module"
import {RateLimiterGuard} from "./rate-limiter.guard"

@Module({
  imports: [ServiceModule, ConfigModule],
  providers: [RateLimiterGuard],
  exports: [RateLimiterGuard]
})
export class RateLimiterModule {}
