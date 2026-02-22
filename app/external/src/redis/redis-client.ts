import {Injectable, OnModuleDestroy, OnModuleInit} from "@nestjs/common"
import Redis from "ioredis"
import {ConfigProvider} from "../config"
import {waitForRedisConnection} from "./redis.utils"

@Injectable()
export class RedisClient extends Redis implements OnModuleInit, OnModuleDestroy {
  constructor(readonly configProvider: ConfigProvider) {
    const config = configProvider.redisConfig
    super({
      host: config.host,
      port: config.port,
      db: config.db,
      enableOfflineQueue: false
    })
  }

  async onModuleInit() {
    await waitForRedisConnection(this, "shared-redis-client")
  }

  onModuleDestroy() {
    this.disconnect()
  }
}
