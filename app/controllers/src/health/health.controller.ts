import {Controller, Get, ServiceUnavailableException} from "@nestjs/common"
import {HealthService} from "@services/health"
import {PublicRoute} from "../../../main/src/auth/jwt.authguard"
import {isLeft} from "fp-ts/lib/Either"
import {HealthResponse} from "@approvio/api"
import {pipe} from "fp-ts/lib/function"
import {mapToGetHealthResponse} from "./health.mapper"
import * as TE from "fp-ts/TaskEither"

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @PublicRoute()
  @Get()
  async getHealth(): Promise<HealthResponse> {
    const result = await pipe(
      this.healthService.checkHealth(),
      TE.map(() => "success" as const),
      TE.mapLeft(error => mapToGetHealthResponse(error)),
      TE.map(mapToGetHealthResponse)
    )()

    if (isLeft(result)) throw new ServiceUnavailableException(result.left)

    return result.right
  }
}
