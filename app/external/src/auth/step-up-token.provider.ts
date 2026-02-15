import {Injectable, OnModuleInit, OnModuleDestroy, Logger} from "@nestjs/common"
import {StepUpTokenRepository} from "@services"
import {ConfigProvider} from "../config/config-provider"
import Redis from "ioredis"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {UnknownError} from "@services/error"

@Injectable()
export class RedisStepUpTokenRepository implements StepUpTokenRepository, OnModuleInit, OnModuleDestroy {
  private redisClient: Redis | undefined
  private readonly keyPrefix = "step_up_token:"

  constructor(private readonly configProvider: ConfigProvider) {}

  async onModuleInit() {
    const config = this.configProvider.redisConfig

    this.redisClient = new Redis({
      host: config.host,
      port: config.port,
      db: config.db,
      enableOfflineQueue: false
    })

    try {
      await new Promise<void>((resolve, reject) => {
        this.getRedisClient().once("ready", resolve)
        this.getRedisClient().once("error", reject)
      })
      Logger.log("RedisStepUpTokenRepository initialized", "RedisStepUpTokenRepository")
    } catch {
      throw new Error(`Unable to connect to Redis at ${config.host}:${config.port}`)
    }
  }

  onModuleDestroy() {
    this.redisClient?.disconnect()
  }

  private getRedisClient(): Redis {
    if (this.redisClient === undefined) throw new Error("Redis client is not initialized")
    return this.redisClient
  }

  markTokenAsUsed(jti: string, ttlSeconds: number): TaskEither<UnknownError, void> {
    return TE.tryCatch(
      async () => {
        const client = this.getRedisClient()
        const key = `${this.keyPrefix}${jti}`
        await client.set(key, "used", "EX", ttlSeconds)
      },
      error => {
        Logger.error(`Failed to mark token as used: ${error}`, "RedisStepUpTokenRepository")
        return "unknown_error" as const
      }
    )
  }

  isTokenUsed(jti: string): TaskEither<UnknownError, boolean> {
    return TE.tryCatch(
      async () => {
        const client = this.getRedisClient()
        const key = `${this.keyPrefix}${jti}`
        const result = await client.get(key)
        return result === "used"
      },
      error => {
        Logger.error(`Failed to check if token is used: ${error}`, "RedisStepUpTokenRepository")
        return "unknown_error" as const
      }
    )
  }
}
