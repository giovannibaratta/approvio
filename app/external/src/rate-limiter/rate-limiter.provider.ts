import {Injectable, OnModuleInit, OnModuleDestroy, Logger} from "@nestjs/common"
import {RateLimiterRedis, RateLimiterRes} from "rate-limiter-flexible"
import Redis from "ioredis"
import {ConfigProvider} from "../config/config-provider"
import {ConsumePointsError, RateLimiterProvider} from "@services"
import * as TE from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {waitForRedisConnection} from "../redis/redis.utils"

export {RateLimiterRes} from "rate-limiter-flexible"

@Injectable()
export class RedisRateLimiterProvider implements RateLimiterProvider, OnModuleInit, OnModuleDestroy {
  private redisClient: Redis | undefined
  private rateLimiter: RateLimiterRedis | undefined

  constructor(private readonly configProvider: ConfigProvider) {}

  async onModuleInit() {
    const config = this.configProvider.rateLimitConfig.redis

    this.redisClient = new Redis({
      host: config.host,
      port: config.port,
      db: config.db,
      enableOfflineQueue: false
    })

    await waitForRedisConnection(this.getRedisClient(), "rate-limiter-redis-client")

    this.rateLimiter = new RateLimiterRedis({
      storeClient: this.redisClient,
      points: this.configProvider.rateLimitConfig.points,
      duration: this.configProvider.rateLimitConfig.durationInSeconds,
      keyPrefix: config.prefix
    })

    Logger.log("RateLimiterService initialized", "RateLimiter")
  }

  onModuleDestroy() {
    this.redisClient?.disconnect()
  }

  private getRedisClient(): Redis {
    if (this.redisClient === undefined) throw new Error("Redis client is not initialized")
    return this.redisClient
  }

  private getRateLimiter(): RateLimiterRedis {
    if (this.rateLimiter === undefined) throw new Error("Rate limiter is not initialized")
    return this.rateLimiter
  }

  consume(key: string, points: number): TaskEither<ConsumePointsError, RateLimiterRes> {
    return TE.tryCatch(
      async () =>
        await pipe(
          this.getRateLimiter()
            .consume(key, points)
            .catch(error => {
              if (error instanceof RateLimiterRes) return error
              throw error
            })
        ),
      error => {
        Logger.error(error, "RateLimiter")
        return "unknown_error" as const
      }
    )
  }

  get points(): number {
    return this.configProvider.rateLimitConfig.points
  }
}
