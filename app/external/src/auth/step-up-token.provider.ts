import {Injectable, Logger} from "@nestjs/common"
import {ConsumeTokenError, StepUpTokenRepository, StoreTokenError} from "@services"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {RedisClient} from "../redis"

@Injectable()
export class RedisStepUpTokenRepository implements StepUpTokenRepository {
  private readonly keyPrefix = "step_up_token:"

  constructor(private readonly redisClient: RedisClient) {}

  storeToken(jti: string, ttlSeconds: number): TaskEither<StoreTokenError, void> {
    return TE.tryCatch(
      async () => {
        const key = `${this.keyPrefix}${jti}`
        // Use Redis SET with 'EX' argument to set the key expiration in seconds
        await this.redisClient.set(key, "active", "EX", ttlSeconds)
      },
      error => {
        Logger.error(`Failed to store token: ${error}`, "RedisStepUpTokenRepository")
        return "unknown_error" as const
      }
    )
  }

  consumeToken(jti: string): TaskEither<ConsumeTokenError, void> {
    return TE.tryCatch(
      async () => {
        const key = `${this.keyPrefix}${jti}`
        const deleted = await this.redisClient.del(key)
        if (deleted === 0) throw new TokenNotFoundError()
        return undefined
      },
      error => {
        if (error instanceof TokenNotFoundError) return "token_not_found" as const
        Logger.error(`Failed to consume token: ${error}`, "RedisStepUpTokenRepository")
        return "unknown_error" as const
      }
    )
  }
}

class TokenNotFoundError extends Error {
  constructor() {
    super("Token not found")
  }
}
