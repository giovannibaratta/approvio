import {Injectable, CanActivate, ExecutionContext, ServiceUnavailableException, Logger} from "@nestjs/common"
import {Reflector} from "@nestjs/core"
import {LeverService, LeverName} from "@services/lever"
import {LEVER_KEY} from "./use-lever.decorator"
import {generateErrorPayload} from "../../../controllers/src/error"

/**
 * A global guard that implements endpoint-specific load shedding.
 *
 * It uses the `@UseLever(leverName)` decorator to identify which lever controls
 * access to a specific route handler or controller. If the specified lever is active,
 * the guard rejects the request with a `503 Service Unavailable` error.
 *
 * This guard should be registered as the first global guard to ensure load shedding
 * occurs before more expensive operations like authentication or database lookups.
 */
@Injectable()
export class LeverGuard implements CanActivate {
  private readonly logger = new Logger(LeverGuard.name)

  constructor(
    private reflector: Reflector,
    private leverService: LeverService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Retrieves the lever name associated with the current request.
    // It checks the specific handler (method) first, then falls back to the class (controller) level.
    // If @UseLever is defined on both, the method-level decorator overrides the controller-level one.
    const leverName = this.reflector.getAllAndOverride<LeverName>(LEVER_KEY, [context.getHandler(), context.getClass()])

    if (!leverName) return true

    const isActive = await this.leverService.isLeverActive(leverName)()

    if (isActive) {
      this.logger.warn(`Endpoint blocked by lever: ${leverName}`)
      throw new ServiceUnavailableException(
        generateErrorPayload(
          "SERVICE_UNAVAILABLE",
          "This operation is temporarily disabled to maintain system stability."
        )
      )
    }

    return true
  }
}
