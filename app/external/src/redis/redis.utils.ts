import {Logger} from "@nestjs/common"
import Redis, {RedisOptions} from "ioredis"
import {RedisConfig} from "../config/interfaces"

/**
 * Converts a RedisConfig object to ioredis RedisOptions.
 *
 * @param config - The Redis configuration from the config provider.
 * @param overrides - Optional overrides for the Redis options.
 * @returns Valid RedisOptions for ioredis.
 */
export function toRedisOptions(config: RedisConfig, overrides: RedisOptions = {}): RedisOptions {
  const baseOptions: RedisOptions =
    config.connection.type === "sentinel"
      ? {
          sentinels: config.connection.sentinels,
          name: config.connection.name,
          sentinelPassword: config.connection.sentinelPassword,
          password: config.connection.password,
          db: config.db
        }
      : {
          host: config.connection.host,
          port: config.connection.port,
          password: config.connection.password,
          db: config.db
        }

  return {
    ...baseOptions,
    ...overrides
  }
}

/**
 * Ensures a Redis connection is fully established before continuing.
 *
 * By default, ioredis connects asynchronously. We wait for the `"ready"` event here to guarantee the connection is usable.
 *
 * We also listen for `"error"` during this startup phase to eagerly throw an error and abort
 * startup if the Redis server is unreachable (e.g. wrong host or port).
 *
 * A check for `client.status === "ready"` is included to avoid a race condition where the
 * connection is established instantly and the `"ready"` event fires
 * *before* the promise listener is attached, which would cause the startup to hang indefinitely.
 */
export async function waitForRedisConnection(client: Redis, clientName: string): Promise<void> {
  if (client.status === "ready") {
    Logger.log(`Redis connection ${clientName} already ready`, "RedisClient")
    return
  }

  try {
    await new Promise<void>((resolve, reject) => {
      client.once("ready", resolve)
      client.once("error", reject)
    })
    Logger.log(`Redis connection ${clientName} ready`, "RedisClient")
  } catch (error) {
    const options = client.options
    if (options.sentinels)
      throw new Error(
        `Unable to connect to Redis Sentinel cluster. Sentinels: ${options.sentinels.map(s => `${s.host}:${s.port}`).join(", ")}`,
        {cause: error}
      )

    throw new Error(`Unable to connect to Redis at ${options.host}:${options.port}`, {cause: error})
  }
}
