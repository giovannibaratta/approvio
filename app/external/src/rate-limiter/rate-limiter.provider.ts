import {Injectable, OnModuleInit, OnModuleDestroy, Logger} from "@nestjs/common"
import {RateLimiterRedis, RateLimiterRes} from "rate-limiter-flexible"
import Redis from "ioredis"
import {ConfigProvider} from "../config/config-provider"
import {ConsumePointsError, RateLimiterProvider} from "@services"
import * as TE from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {TaskEither} from "fp-ts/lib/TaskEither"

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

    // Wait for the Redis TCP connection to be established before accepting requests.
    // This is required because enableOfflineQueue is false, which means commands sent
    // before the connection is ready will fail immediately instead of being queued.
    // The "error" listener ensures that connection failures (e.g. wrong host/port)
    // surface at startup rather than silently falling through to the fail-open path.
    try {
      await new Promise<void>((resolve, reject) => {
        this.getRedisClient().once("ready", resolve)
        this.getRedisClient().once("error", reject)
      })
    } catch {
      throw new Error(`Unable to connect to Redis at ${config.host}:${config.port}`)
    }

    this.rateLimiter = new RateLimiterRedis({
      storeClient: this.redisClient,
      points: this.configProvider.rateLimitConfig.points,
      duration: this.configProvider.rateLimitConfig.durationInSeconds,
      keyPrefix: config.prefix
    })

    Logger.log("RateLimiterService initialized", "RateLimiter")
  }

  onModuleDestroy() {
    this.getRedisClient().disconnect()
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
              if (error instanceof RateLimiterRes) {
                return error
              }
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
