import {Module} from "@nestjs/common"
import {RedisRateLimiterProvider} from "./rate-limiter.provider"
import {ConfigModule} from "../config.module"
import {RATE_LIMITER_PROVIDER_TOKEN} from "@services"

const provider = {
  provide: RATE_LIMITER_PROVIDER_TOKEN,
  useClass: RedisRateLimiterProvider
}

@Module({
  imports: [ConfigModule],
  providers: [provider],
  exports: [provider]
})
export class RateLimiterModule {}
