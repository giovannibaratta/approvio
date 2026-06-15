import {Injectable, NestMiddleware, ServiceUnavailableException, Logger} from "@nestjs/common"
import {Request, Response, NextFunction} from "express"
import {LeverService} from "@services/lever"
import {generateErrorPayload} from "../../../controllers/src/error"

@Injectable()
export class LeverMiddleware implements NestMiddleware {
  private readonly logger = new Logger(LeverMiddleware.name)

  constructor(private readonly leverService: LeverService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const result = await this.leverService.isLeverActive("read_only_mode")()

      if (result) {
        this.logger.warn(`Blocked ${req.method} request to ${req.originalUrl} due to read_only_mode lever.`)
        throw new ServiceUnavailableException(
          generateErrorPayload(
            "SERVICE_UNAVAILABLE",
            "The system is currently in read-only mode to maintain stability. Please try again later."
          )
        )
      }
    }
    next()
  }
}
