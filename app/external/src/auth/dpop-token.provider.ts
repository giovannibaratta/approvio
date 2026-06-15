import {Injectable, Logger} from "@nestjs/common"
import {DpopTokenRepository, UnknownError} from "@services"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {RedisClient} from "../redis"

@Injectable()
export class RedisDpopTokenRepository implements DpopTokenRepository {
  private readonly keyPrefix = "dpop_jti:"

  constructor(private readonly redisClient: RedisClient) {}

  markJtiAsUsed(jti: string, ttlSeconds: number): TaskEither<UnknownError | "dpop_jti_reused", void> {
    return TE.tryCatch(
      async () => {
        const key = `${this.keyPrefix}${jti}`
        // Use Redis SET with 'EX' (expiration) and 'NX' (only set if not exists)
        const result = await this.redisClient.set(key, "used", "EX", ttlSeconds, "NX")

        if (result !== "OK") throw new JtiReusedError()
      },
      error => {
        if (error instanceof JtiReusedError) return "dpop_jti_reused" as const
        Logger.error(`Failed to store DPoP JTI: ${String(error)}`, "RedisDpopTokenRepository")
        return "unknown_error" as const
      }
    )
  }
}

class JtiReusedError extends Error {
  constructor() {
    super("DPoP JTI has already been used")
  }
}
