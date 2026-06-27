import {Controller, Get, ServiceUnavailableException, UseGuards} from "@nestjs/common"
import {HealthService} from "@services/health"
import {PublicRoute} from "../../../../main/src/auth/jwt.authguard"
import {isLeft} from "fp-ts/Either"
import {HealthResponse} from "@approvio/api"
import {pipe} from "fp-ts/function"
import {mapToGetHealthResponse} from "./health.mapper"
import * as TE from "fp-ts/TaskEither"
import {HealthRateLimiterGuard} from "../../../../main/src/rate-limiter"

@Controller("internal/health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @PublicRoute()
  @UseGuards(HealthRateLimiterGuard)
  @Get()
  async getHealth(): Promise<HealthResponse> {
    const result = await pipe(
      this.healthService.checkHealth(),
      TE.map(() => "success" as const),
      // TOOD: Instead of having this double mapping here, why not hardcod the succes in the return
      // and modify the throw to do only mapping of the errors ? It is more aligned to other
      // controllers.
      TE.mapLeft(error => mapToGetHealthResponse(error)),
      TE.map(mapToGetHealthResponse)
    )()

    if (isLeft(result)) throw new ServiceUnavailableException(result.left)

    return result.right
  }
}
