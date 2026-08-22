import {Inject, Injectable} from "@nestjs/common"
import {EvaluationContext} from "@openfeature/server-sdk"
import {LeverProvider, LEVER_PROVIDER_TOKEN} from "./lever.interface"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {Task, of as taskOf} from "fp-ts/Task"

/**
 * List of all supported operational levers (feature flags) in the system.
 */
export type LeverName =
  /**
   * Puts the entire system into read-only mode.
   * Blocks all POST, PUT, PATCH, and DELETE requests at the middleware level.
   */
  | "read_only_mode"
  /**
   * Specifically disables the creation of new workflows.
   */
  | "disable_workflow_creation"
  /**
   * Disables the background worker responsible for sweeping expired workflows.
   */
  | "disable_workflow_expiration_sweep"
  // TODO(long-term): "disable_auth_provider" currently uses context targeting ({ providerId }).
  // Consider dynamic lever names (e.g. `disable_auth_provider_${string}`) or a dedicated
  // multi-variant lever structure to prevent accidental global enable if context is omitted in Feature Flag management software.
  /**
   * Specifically disables an authentication provider.
   * Target specific providers in OpenFeature via `providerId` (or `targetingKey`) context attribute.
   */
  | "disable_auth_provider"

/**
 * Centralized default values for each lever.
 */
const LEVER_DEFAULTS: Record<LeverName, boolean> = {
  read_only_mode: false,
  disable_workflow_creation: false,
  disable_workflow_expiration_sweep: false,
  disable_auth_provider: false
}

/**
 * Service responsible for evaluating operational levers (feature flags).
 * It acts as an agnostic wrapper around the injected LeverProvider.
 *
 * This service is purely focused on business logic and is decoupled from
 * the actual feature flag implementation (e.g., Unleash, OpenFeature).
 */
@Injectable()
export class LeverService {
  constructor(
    @Inject(LEVER_PROVIDER_TOKEN)
    private readonly provider: LeverProvider
  ) {}

  /**
   * Evaluates if a specific authentication provider is disabled via feature flags.
   *
   * @param providerId The unique identifier of the authentication provider (e.g. "okta", "auth0")
   * @returns A Task resolving to `true` if the provider is disabled, `false` otherwise.
   */
  isAuthProviderDisabled(providerId: string): Task<boolean> {
    return this.isLeverActive("disable_auth_provider", {
      targetingKey: providerId,
      providerId
    })
  }

  /**
   * Evaluates if a boolean lever is active.
   * The default value is retrieved from the centralized LEVER_DEFAULTS map.
   *
   * If the provider fails or the cache is too stale, this will return the
   * defaultValue instead of an error.
   *
   * This method returns a Task<boolean> to ensure it never fails in critical paths.
   *
   * @param leverName The name of the feature flag / lever
   * @param context Optional evaluation context (e.g., user ID, tenant ID)
   * @returns A Task resolving to `true` if the lever is active, `false` otherwise.
   */
  isLeverActive(leverName: LeverName, context?: EvaluationContext): Task<boolean> {
    const defaultValue = LEVER_DEFAULTS[leverName]

    return pipe(
      this.provider.isLeverActive(leverName, defaultValue, context),
      TE.getOrElse(() => taskOf(defaultValue))
    )
  }
}
