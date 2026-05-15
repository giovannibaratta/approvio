import {Injectable, OnModuleDestroy, OnModuleInit} from "@nestjs/common"
import Redis from "ioredis"
import {ConfigProvider} from "../config"
import {toRedisOptions, waitForRedisConnection} from "./redis.utils"

@Injectable()
export class RedisClient extends Redis implements OnModuleInit, OnModuleDestroy {
  constructor(readonly configProvider: ConfigProvider) {
    super(toRedisOptions(configProvider.redisConfig, {enableOfflineQueue: false}))
  }

  async onModuleInit() {
    await waitForRedisConnection(this, "shared-redis-client")
  }

  onModuleDestroy() {
    this.disconnect()
  }
}
