import {
  Provider,
  ResolutionDetails,
  EvaluationContext,
  StandardResolutionReasons,
  ErrorCode
} from "@openfeature/server-sdk"
import {Unleash, initialize, InMemStorageProvider, Context, getFeatureToggleDefinitions} from "unleash-client"
import {FeatureInterface, ClientFeaturesResponse} from "unleash-client/lib/feature"
import {Logger} from "@nestjs/common"

/**
 * OpenFeature provider for Unleash.
 *
 * Performance and Caching:
 * Per ADR 005, evaluations are performed purely in local memory with O(1) complexity.
 * This provider wraps the Unleash Node.js SDK, which maintains a local cache of all
 * rules by periodically polling the Unleash server in the background.
 * This ensures that flag evaluations are instantaneous and do not block the
 * application's event loop or perform any synchronous network/I/O operations
 * in the request path.
 *
 * Resilience and Staleness:
 * If the Unleash server becomes unreachable, the provider will continue to serve
 * the last known good state from its cache. However, to prevent using excessively
 * stale data during prolonged outages, the provider tracks the last successful
 * synchronization. If the cache hasn't been refreshed for more than 5 minutes,
 * evaluations will fail, triggering the service-level fail-open fallback.
 */
export class UnleashProvider implements Provider {
  readonly metadata = {
    name: "unleash-local-provider"
  }

  private unleash: Unleash | undefined
  private isInitialized = false
  private lastSyncTimestamp: number = 0
  private refreshTimer?: NodeJS.Timeout
  private readonly STALENESS_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

  constructor(
    private readonly url: string,
    private readonly clientKey?: string,
    private readonly appName: string = "approvio",
    private readonly refreshInterval: number = 15000,
    private readonly bootstrapData?: FeatureInterface[]
  ) {}

  async initialize(): Promise<void> {
    if (this.isInitialized) return

    const disableMetrics = true

    /**
     * The InMemStorageProvider is used to store the feature toggle definitions
     * in local memory. The Unleash Node.js SDK polls the server in the background
     * and updates this local storage. This ensures all evaluations (isEnabled, getVariant)
     * are pure memory lookups with O(1) performance.
     */
    const storageProvider = new InMemStorageProvider<ClientFeaturesResponse>()

    const customHeaders: Record<string, string> = {}
    if (this.clientKey) customHeaders.Authorization = this.clientKey

    // Assigning to a local variable first to avoid non-null assertions and
    // ensure clear initialization flow. This does not cause memory leaks
    // as it's a standard reference assignment.
    const unleashInstance = initialize({
      url: this.url,
      appName: this.appName,
      refreshInterval: this.refreshInterval,
      customHeaders,
      disableMetrics,
      bootstrap: this.bootstrapData ? {data: this.bootstrapData} : undefined,
      storageProvider
    })

    this.unleash = unleashInstance

    const logConfig = () => {
      const definitions = getFeatureToggleDefinitions()
      if (!definitions) {
        Logger.log("Unleash synchronized, but no definitions found.", "UnleashProvider")
        return
      }
      const simpleConfig = definitions.reduce(
        (acc, def) => {
          acc[def.name] = def.enabled
          return acc
        },
        {} as Record<string, boolean>
      )
      Logger.log(`Unleash synchronized. Current configuration: ${JSON.stringify(simpleConfig)}`, "UnleashProvider")
    }

    return new Promise(resolve => {
      unleashInstance.on("synchronized", () => {
        this.isInitialized = true
        this.lastSyncTimestamp = Date.now()
        logConfig()

        if (!this.refreshTimer && this.refreshInterval > 0)
          this.refreshTimer = setInterval(() => logConfig(), this.refreshInterval)

        resolve()
      })
      unleashInstance.on("changed", () => {
        this.lastSyncTimestamp = Date.now()
        logConfig()
      })
      unleashInstance.on("error", err => {
        Logger.error(`Unleash error: ${err}`)
        // Fail open - resolve anyway to avoid blocking startup
        this.isInitialized = true
        resolve()
      })
    })
  }

  onClose(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.unleash) this.unleash.destroy()
    return Promise.resolve()
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext
  ): Promise<ResolutionDetails<boolean>> {
    if (!this.unleash || !this.isInitialized)
      return Promise.resolve({
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.PROVIDER_NOT_READY
      })

    if (this.isStale())
      return Promise.resolve({
        value: defaultValue,
        reason: StandardResolutionReasons.STALE,
        errorCode: ErrorCode.PROVIDER_NOT_READY
      })

    const contextData = this.mapContext(context)
    const enabled = this.unleash.isEnabled(flagKey, contextData, defaultValue)

    return Promise.resolve({
      value: enabled,
      reason: StandardResolutionReasons.CACHED
    })
  }

  resolveStringEvaluation(): Promise<ResolutionDetails<string>> {
    throw new Error("resolveStringEvaluation is not supported by this provider")
  }

  resolveNumberEvaluation(): Promise<ResolutionDetails<number>> {
    throw new Error("resolveNumberEvaluation is not supported by this provider")
  }

  resolveObjectEvaluation(): Promise<ResolutionDetails<never>> {
    throw new Error("resolveObjectEvaluation is not supported by this provider")
  }

  private mapContext(_: EvaluationContext): Context {
    // As of now, no context is supported
    return {}
  }

  private isStale(): boolean {
    // If we have synced at least once, check if the last sync was too long ago.
    // We only consider it stale if we've had at least one sync, otherwise we
    // rely on bootstrap data or fail-open.
    return this.lastSyncTimestamp > 0 && Date.now() - this.lastSyncTimestamp > this.STALENESS_THRESHOLD_MS
  }
}
