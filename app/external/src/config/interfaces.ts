import {Option} from "fp-ts/lib/Option"
import {OidcProvider} from "./types"

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

export interface RedisConfig {
  host: string
  port: number
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

export interface ConfigProviderInterface {
  /**
   * Indicates if the privilege mode (step-up authentication) is enabled.
   * When enabled, the system allows high-privilege token flows for sensitive operations.
   * This can be disabled by setting the DISABLE_HIGH_PRIVILEGE_MODE environment variable to 'true'.
   */
  isPrivilegeMode: boolean
  dbConnectionUrl: string
  emailProviderConfig: Option<EmailProviderConfig>
  oidcConfig: OidcProviderConfig
  jwtConfig: JwtConfig
  redisConfig: RedisConfig
  rateLimitConfig: RateLimitConfig
}
