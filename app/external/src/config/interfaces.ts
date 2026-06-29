import {KmsProviderType} from "./types"
import {Option} from "fp-ts/Option"
import {OidcProvider} from "./types"
import {FeatureInterface} from "unleash-client/lib/feature"

export const DEFAULT_RATE_LIMIT_ENTITY_POINTS = 50
export const DEFAULT_RATE_LIMIT_DURATION_IN_SECONDS = 60

export type EmailProviderConfig = GenericEmailProviderConfig

export interface GenericEmailProviderConfig {
  type: "generic"
  smtpUsername: string
  smtpPassword: string
  smtpEndpoint: string
  smtpPort: number
  senderEmail: string
  allowSelfSignedCertificates: boolean
}

export interface OidcProviderConfig {
  provider: OidcProvider
  issuerUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
  allowInsecure?: boolean
  override?: {
    authorizationEndpoint: string
    tokenEndpoint: string
    userinfoEndpoint: string
  }
  scopes?: string
}

export interface JwtConfig {
  secret: string
  trustedIssuers: [string, ...string[]]
  issuer: string
  audience: string
  accessTokenExpirationSec?: number
}

export type RedisConnection =
  | {
      type: "plain"
      host: string
      port: number
      password?: string
    }
  | {
      type: "sentinel"
      sentinels: {host: string; port: number}[]
      name: string
      sentinelPassword?: string
      password?: string
    }

export interface RedisConfig {
  connection: RedisConnection
  db: number
  prefix?: string
}

export interface RateLimitConfig {
  // Indicates how many points are assigned to each entity for the given duration. If the entity
  // uses more than the number of points for the duration, the request will be rejected.
  points: number
  durationInSeconds: number
  redis: RedisConfig
}

export interface WebhookRetryConfig {
  maxAttempts: number
  initialDelayMs: number
  backoffFactor: number
  maxDelayMs: number
}

export interface EmailRetryConfig {
  maxAttempts: number
  initialDelayMs: number
  backoffFactor: number
  maxDelayMs: number
}

export interface DatabaseRetryConfig {
  maxAttempts: number
  initialDelayMs: number
  backoffFactor: number
  maxDelayMs: number
}

export interface SsrfProtectionConfig {
  /**
   * Protection mode:
   * - "strict"   — Block all private/reserved IPs (default, recommended for SaaS)
   * - "disabled" — No SSRF protection (for trusted/isolated environments only)
   */
  mode: "strict" | "disabled"

  /**
   * Optional allowlist of domains or CIDR ranges that bypass SSRF checks.
   * Only applies when mode is "strict".
   * Examples: ["internal-api.corp.example.com", "10.0.5.0/24"]
   */
  allowedDestinations?: string[]
}

export interface ConfigProviderInterface {
  /**
   * Indicates if the privilege mode (step-up authentication) is enabled.
   * When enabled, the system allows high-privilege token flows for sensitive operations.
   * This can be disabled by setting the DISABLE_HIGH_PRIVILEGE_MODE environment variable to 'true'.
   */
  isPrivilegeMode: boolean
  dbConnectionUrl: string
  emailProviderConfig: Option<EmailProviderConfig>
  oidcProviders: Map<string, OidcProviderConfig>
  jwtConfig: JwtConfig
  redisConfig: RedisConfig
  rateLimitConfig: RateLimitConfig
  webhookRetryConfig: WebhookRetryConfig
  emailRetryConfig: EmailRetryConfig
  databaseRetryConfig: DatabaseRetryConfig
  /** URL of the frontend application. Used by the auth callback to redirect after login. */
  frontendUrl: string
  /** Whether to set the Secure flag on auth cookies. Set to false for local HTTP development. */
  cookieSecure: boolean
  kmsConfig: KmsConfig
  ssrfProtectionConfig: SsrfProtectionConfig
  leverConfig: LeverConfig
  /** TTL for the health check result cache in milliseconds. */
  healthCacheTtlMs?: number
}

export type LeverConfig =
  | {
      /** Lever provider is disabled. All levers will return their default fallback values (fail-open). */
      enabled: false
    }
  | {
      enabled: true
      provider: "unleash"
      /**
       * URL of the remote Unleash API.
       * Mandatory when enabled, as the system always expects to eventually synchronize with a control plane.
       */
      unleashUrl: string
      /** API Token for authenticating with the Unleash server. */
      unleashApiToken?: string
      /**
       * How often (in ms) to poll the Unleash server for updates.
       * Default is 15000 (15 seconds).
       */
      refreshInterval?: number
      /**
       * Parsed and validated bootstrap data.
       */
      bootstrapData?: FeatureInterface[]
    }

export interface KmsConfig {
  type: KmsProviderType
  // Retrieves the Map of version-to-Buffer master keys.
  // Supports exactly-once consumption: the first call returns the keys,
  // and subsequent calls throw an error to prevent reuse of zeroed buffers.
  getKeys(): Map<number, Buffer>
  // The active key version used for encrypting new data.
  // Note: Keeping this version explicit (rather than defaulting to the latest version)
  // allows for safe key rotation during rolling deployments:
  // 1. Distribute Phase: Add the new key material to env (e.g., KMS_MASTER_KEY_V2) so all
  //    instances can decrypt data encrypted with it, while still keeping currentVersion at 'v1'.
  // 2. Activate Phase: Once all nodes are updated, change KMS_MASTER_KEY_VERSION to 'v2'
  //    to toggle the write-path encryption key safely.
  currentVersion: number
}
