import {Injectable, Logger, OnModuleDestroy, OnModuleInit} from "@nestjs/common"
import {OpenFeature, Client, EvaluationContext} from "@openfeature/server-sdk"
import {LeverProvider, LeverName, LeverError} from "@services/lever"
import {ConfigProvider} from "../config/config-provider"
import {UnleashProvider} from "./unleash-provider"
import * as TE from "fp-ts/TaskEither"

@Injectable()
export class OpenFeatureLeverProvider implements LeverProvider, OnModuleInit, OnModuleDestroy {
  private client: Client

  constructor(private readonly config: ConfigProvider) {
    this.client = OpenFeature.getClient("approvio-levers")
  }

  async onModuleInit() {
    const leverConfig = this.config.leverConfig

    if (leverConfig.enabled) {
      Logger.log("Initializing OpenFeature with Unleash provider")

      const provider = new UnleashProvider(
        leverConfig.unleashUrl,
        leverConfig.unleashApiToken,
        "approvio",
        leverConfig.refreshInterval,
        leverConfig.bootstrapData
      )

      try {
        await OpenFeature.setProviderAndWait(provider)
        Logger.log("OpenFeature provider initialized successfully")
      } catch (e) {
        Logger.warn(`Failed to initialize OpenFeature provider, failing open: ${e}`)
      }
    } else Logger.log("Lever provider is disabled. Using default No-Op Provider.")
  }

  async onModuleDestroy() {
    await OpenFeature.close()
  }

  isLeverActive(
    leverName: LeverName,
    defaultValue: boolean,
    context?: EvaluationContext
  ): TE.TaskEither<LeverError, boolean> {
    return TE.tryCatch(
      () => this.client.getBooleanValue(leverName, defaultValue, context),
      error => {
        Logger.error(`Error evaluating lever ${leverName}: ${error}`)
        return "lever_provider_error" as const
      }
    )
  }
}
