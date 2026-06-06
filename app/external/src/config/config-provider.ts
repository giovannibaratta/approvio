import {Injectable} from "@nestjs/common"
import {Option} from "fp-ts/Option"
import * as O from "fp-ts/Option"
import {
  ConfigProviderInterface,
  DEFAULT_RATE_LIMIT_DURATION_IN_SECONDS,
  DEFAULT_RATE_LIMIT_ENTITY_POINTS,
  EmailProviderConfig,
  JwtConfig,
  OidcProviderConfig,
  RateLimitConfig,
  RedisConfig,
  WebhookRetryConfig,
  EmailRetryConfig,
  DatabaseRetryConfig,
  KmsConfig
} from "./interfaces"
import {isOidcProvider, isKmsProviderType} from "./types"
import {isEmail, isNonEmptyArray} from "@utils"

const IS_PRIVILEGE_MODE_DEFAULT = true

@Injectable()
export class ConfigProvider implements ConfigProviderInterface {
  readonly isPrivilegeMode: boolean
  readonly dbConnectionUrl: string
  readonly emailProviderConfig: Option<EmailProviderConfig>
  readonly oidcConfig: OidcProviderConfig
  readonly jwtConfig: JwtConfig
  readonly redisConfig: RedisConfig
  readonly rateLimitConfig: RateLimitConfig
  readonly webhookRetryConfig: WebhookRetryConfig
  readonly emailRetryConfig: EmailRetryConfig
  readonly databaseRetryConfig: DatabaseRetryConfig
  readonly frontendUrl: string
  readonly cookieSecure: boolean
  readonly kmsConfig: KmsConfig

  constructor() {
    this.isPrivilegeMode = this.validatePrivilegeMode()
    this.dbConnectionUrl = this.validateConnectionUrl()
    this.emailProviderConfig = ConfigProvider.validateEmailProviderConfig()
    this.oidcConfig = this.validateOidcProviderConfig()
    this.jwtConfig = this.validateJwtConfig()
    // redisConfig must be initialized BEFORE rateLimitConfig because the latter
    // falls back to the main redisConfig if no specific rate limit connection is provided.
    this.redisConfig = this.validateRedisConfig()
    this.rateLimitConfig = this.validateRateLimitConfig()
    this.webhookRetryConfig = this.validateWebhookRetryConfig()
    this.emailRetryConfig = this.validateEmailRetryConfig()
    this.databaseRetryConfig = this.validateDatabaseRetryConfig()
    this.frontendUrl = this.validateFrontendUrl()
    this.cookieSecure = this.validateCookieSecure()
    this.kmsConfig = this.validateKmsConfig()
  }

  private validatePrivilegeMode(): boolean {
    const disableModeRaw = process.env.DISABLE_HIGH_PRIVILEGE_MODE

    if (disableModeRaw !== undefined) {
      if (disableModeRaw.toLowerCase() !== "true" && disableModeRaw.toLowerCase() !== "false")
        throw new Error("DISABLE_HIGH_PRIVILEGE_MODE must be 'true' or 'false'")
      return disableModeRaw.toLowerCase() === "false"
    }

    return IS_PRIVILEGE_MODE_DEFAULT
  }

  private validateConnectionUrl(): string {
    const connectionUrl = process.env.DATABASE_URL

    if (connectionUrl === undefined) throw new Error("DATABASE_URL is not defined")

    return connectionUrl
  }

  static validateEmailProviderConfig(): Option<EmailProviderConfig> {
    const smtpUsername = process.env.SMTP_USERNAME
    const smtpPassword = process.env.SMTP_PASSWORD
    const smtpEndpoint = process.env.SMTP_ENDPOINT
    const smtpPortRaw = process.env.SMTP_PORT
    const smtpAllowSelfSignedRaw = process.env.SMTP_ALLOWED_SELF_SIGNED_CERTIFICATES
    const senderEmail = process.env.SMTP_SENDER_EMAIL

    if (!smtpUsername && !smtpPassword && !smtpEndpoint && !senderEmail) return O.none

    if (!smtpUsername || !smtpPassword || !smtpEndpoint || !senderEmail)
      throw new Error("Incomplete email provider configuration")

    if (smtpUsername.length === 0 || smtpPassword.length === 0 || smtpEndpoint.length === 0 || senderEmail.length === 0)
      throw new Error("Email provider configuration values cannot be empty")

    let smtpPort: number | undefined

    if (smtpPortRaw !== undefined) {
      try {
        smtpPort = parseInt(smtpPortRaw)
      } catch (error) {
        throw new Error("SMTP_PORT must be a valid number", {cause: error})
      }

      if (smtpPort <= 0 || smtpPort > 65535) throw new Error("SMTP_PORT must be a valid number between 1 and 65535")
    }

    let allowSelfSignedCertificates = false

    if (smtpAllowSelfSignedRaw !== undefined) {
      if (smtpAllowSelfSignedRaw.toLowerCase() !== "true" && smtpAllowSelfSignedRaw.toLowerCase() !== "false")
        throw new Error("SMTP_ALLOWED_SELF_SIGNED_CERTIFICATES must be 'true' or 'false'")
      allowSelfSignedCertificates = smtpAllowSelfSignedRaw.toLowerCase() === "true"
    }

    if (!isEmail(senderEmail)) throw new Error("SMTP_SENDER_EMAIL must be a valid email")

    return O.some({
      type: "generic",
      smtpUsername,
      smtpPassword,
      smtpEndpoint,
      smtpPort: smtpPort ?? 587,
      senderEmail,
      allowSelfSignedCertificates
    })
  }

  private validateOidcProviderConfig(): OidcProviderConfig {
    const providerRaw = process.env.OIDC_PROVIDER

    let provider: OidcProviderConfig["provider"] = "custom"

    if (providerRaw) {
      if (!isOidcProvider(providerRaw)) throw new Error("OIDC_PROVIDER not supported")

      provider = providerRaw
    }

    const issuerUrl = process.env.OIDC_ISSUER_URL
    const clientId = process.env.OIDC_CLIENT_ID
    const clientSecret = process.env.OIDC_CLIENT_SECRET
    const redirectUri = process.env.OIDC_REDIRECT_URI

    const authorizationEndpoint = process.env.OIDC_AUTHORIZATION_ENDPOINT
    const tokenEndpoint = process.env.OIDC_TOKEN_ENDPOINT
    const userinfoEndpoint = process.env.OIDC_USERINFO_ENDPOINT
    const scopes = process.env.OIDC_SCOPES

    let override: OidcProviderConfig["override"] | undefined = undefined

    if (!issuerUrl || !clientId || !clientSecret || !redirectUri)
      throw new Error("Incomplete OIDC provider configuration")

    if (issuerUrl.length === 0 || clientId.length === 0 || clientSecret.length === 0 || redirectUri.length === 0)
      throw new Error("OIDC provider configuration values cannot be empty")

    try {
      new URL(issuerUrl)
    } catch {
      throw new Error("OIDC_ISSUER_URL must be a valid URL")
    }

    try {
      new URL(redirectUri)
    } catch {
      throw new Error("OIDC_REDIRECT_URI must be a valid URL")
    }

    // Either all attributes are provided or none, mix is considered an error.
    if (authorizationEndpoint && tokenEndpoint && userinfoEndpoint) {
      try {
        new URL(authorizationEndpoint)
      } catch {
        throw new Error("OIDC_AUTHORIZATION_ENDPOINT must be a valid URL")
      }

      try {
        new URL(tokenEndpoint)
      } catch {
        throw new Error("OIDC_TOKEN_ENDPOINT must be a valid URL")
      }

      try {
        new URL(userinfoEndpoint)
      } catch {
        throw new Error("OIDC_USERINFO_ENDPOINT must be a valid URL")
      }

      override = {
        authorizationEndpoint,
        tokenEndpoint,
        userinfoEndpoint
      }
    } else if (authorizationEndpoint || tokenEndpoint || userinfoEndpoint) {
      throw new Error(
        "Incomplete manual OIDC configuration. If providing manual endpoints, all of authorization, token, and userinfo endpoints must be specified."
      )
    }

    let allowInsecure = false

    if (process.env.OIDC_ALLOW_INSECURE !== undefined) {
      if (
        process.env.OIDC_ALLOW_INSECURE.toLowerCase() !== "true" &&
        process.env.OIDC_ALLOW_INSECURE.toLowerCase() !== "false"
      ) {
        throw new Error("OIDC_ALLOW_INSECURE must be 'true' or 'false'")
      }
      allowInsecure = process.env.OIDC_ALLOW_INSECURE.toLowerCase() === "true"
    }

    return {
      provider,
      issuerUrl,
      clientId,
      clientSecret,
      redirectUri,
      allowInsecure,
      override,
      scopes
    }
  }

  private validateJwtConfig(): JwtConfig {
    const jwtSecret = process.env.JWT_SECRET
    const trustedIssuersEnv = process.env.JWT_TRUSTED_ISSUERS
    const issuerEnv = process.env.JWT_ISSUER
    const audienceEnv = process.env.JWT_AUDIENCE
    const accessTokenExpirationSecRaw = process.env.JWT_ACCESS_TOKEN_EXPIRATION_SEC

    if (!jwtSecret) throw new Error("JWT_SECRET is not defined")
    if (jwtSecret.length === 0) throw new Error("JWT_SECRET cannot be empty")

    if (trustedIssuersEnv === undefined || trustedIssuersEnv.length <= 0)
      throw new Error("JWT_TRUSTED_ISSUERS is not defined")

    const trustedIssuers = trustedIssuersEnv.split(",").map(issuer => issuer.trim())

    if (trustedIssuers.filter(iss => iss.length <= 0).length > 0)
      throw new Error("JWT_TRUSTED_ISSUER can not contain empty elements")

    if (!isNonEmptyArray(trustedIssuers)) throw new Error("JWT trusted issuers list cannot be empty")

    if (issuerEnv === undefined || issuerEnv.length <= 0) throw new Error("JWT_ISSUER is not defined")

    if (audienceEnv === undefined || audienceEnv.length <= 0) throw new Error("JWT_AUDIENCE is not defined")

    let accessTokenExpirationSec: number | undefined

    if (accessTokenExpirationSecRaw !== undefined) {
      accessTokenExpirationSec = parseInt(accessTokenExpirationSecRaw, 10)

      if (isNaN(accessTokenExpirationSec)) throw new Error("JWT_ACCESS_TOKEN_EXPIRATION_SEC must be a valid number")
      if (accessTokenExpirationSec <= 0) throw new Error("JWT_ACCESS_TOKEN_EXPIRATION_SEC must be greater than 0")
    }

    return {
      secret: jwtSecret,
      trustedIssuers,
      issuer: issuerEnv,
      audience: audienceEnv,
      accessTokenExpirationSec
    }
  }

  private validateRedisConfig(): RedisConfig {
    return this.readRedisConfig("REDIS_")
  }

  private validateRateLimitConfig(): RateLimitConfig {
    const pointsRaw = process.env.RATE_LIMIT_POINTS
    const durationRaw = process.env.RATE_LIMIT_DURATION

    let points = DEFAULT_RATE_LIMIT_ENTITY_POINTS

    if (pointsRaw) {
      points = parseInt(pointsRaw, 10)
      if (isNaN(points) || points <= 0) throw new Error("RATE_LIMIT_POINTS must be a valid number > 0")
    }

    let durationInSeconds = DEFAULT_RATE_LIMIT_DURATION_IN_SECONDS

    if (durationRaw) {
      durationInSeconds = parseInt(durationRaw, 10)
      if (isNaN(durationInSeconds) || durationInSeconds <= 0)
        throw new Error("RATE_LIMIT_DURATION must be a valid number > 0")
    }

    // If no specific Rate Limit Redis connection is defined, reuse the main one.
    const hasRateLimitConnection =
      process.env.RATE_LIMIT_REDIS_HOST !== undefined || process.env.RATE_LIMIT_REDIS_SENTINELS !== undefined
    const redis = hasRateLimitConnection ? this.readRedisConfig("RATE_LIMIT_REDIS_") : this.redisConfig

    return {
      points,
      durationInSeconds,
      redis: {
        ...redis,
        prefix: process.env.RATE_LIMIT_REDIS_PREFIX || redis.prefix || "rl"
      }
    }
  }

  /**
   * Reads Redis configuration from environment variables using a specific prefix.
   *
   * @param prefix - The environment variable prefix (e.g., "REDIS_" or "RATE_LIMIT_REDIS_").
   * @returns A complete RedisConfig object.
   */
  private readRedisConfig(prefix: string): RedisConfig {
    const host = process.env[`${prefix}HOST`]
    const unparsedPort = process.env[`${prefix}PORT`]
    const sentinels = this.parseSentinels(prefix, process.env[`${prefix}SENTINELS`])
    const name = process.env[`${prefix}SENTINEL_NAME`] || "mymaster"
    const sentinelPassword = process.env[`${prefix}SENTINEL_PASSWORD`]
    const password = process.env[`${prefix}PASSWORD`]

    const unparsedDb = process.env[`${prefix}DB`] || "0"
    const redisPrefix = process.env[`${prefix}PREFIX`]

    const db: number = parseInt(unparsedDb, 10)
    if (isNaN(db) || db < 0 || db > 15) throw new Error(`${prefix}DB must be a valid number between 0 and 15`)

    if (sentinels) {
      return {
        connection: {
          type: "sentinel",
          sentinels,
          name,
          sentinelPassword,
          password
        },
        db,
        prefix: redisPrefix
      }
    } else {
      if (host === undefined) throw new Error(`${prefix}HOST or ${prefix}SENTINELS is not defined`)
      if (unparsedPort === undefined || unparsedPort === "") throw new Error(`${prefix}PORT is not defined`)

      const port: number = parseInt(unparsedPort, 10)

      if (isNaN(port) || port <= 0 || port > 65535)
        throw new Error(`${prefix}PORT must be a valid number between 1 and 65535`)

      return {
        connection: {
          type: "plain",
          host: host,
          port: port,
          password
        },
        db,
        prefix: redisPrefix
      }
    }
  }

  private validateFrontendUrl(): string {
    const frontendUrl = process.env.FRONTEND_URL

    if (!frontendUrl) throw new Error("FRONTEND_URL is not defined")
    if (frontendUrl.length === 0) throw new Error("FRONTEND_URL cannot be empty")

    try {
      new URL(frontendUrl)
    } catch {
      throw new Error("FRONTEND_URL must be a valid URL")
    }

    return frontendUrl
  }

  private validateCookieSecure(): boolean {
    const cookieSecureRaw = process.env.COOKIE_SECURE

    if (cookieSecureRaw === undefined) return true

    if (cookieSecureRaw.toLowerCase() !== "true" && cookieSecureRaw.toLowerCase() !== "false")
      throw new Error("COOKIE_SECURE must be 'true' or 'false'")

    return cookieSecureRaw.toLowerCase() !== "false"
  }

  private parseSentinels(prefix: string, raw?: string): {host: string; port: number}[] | undefined {
    if (!raw) return undefined

    return raw.split(",").map(s => {
      const [shost, sport] = s.split(":")
      if (!shost || !sport) throw new Error(`Invalid sentinel configuration in ${prefix}SENTINELS`)
      const port = parseInt(sport, 10)
      if (isNaN(port) || port <= 0 || port > 65535) throw new Error(`Invalid sentinel port in ${prefix}SENTINELS`)
      return {host: shost, port}
    })
  }

  private validateWebhookRetryConfig(): WebhookRetryConfig {
    const maxAttemptsRaw = process.env.WEBHOOK_RETRY_MAX_ATTEMPTS
    const initialDelayMsRaw = process.env.WEBHOOK_RETRY_INITIAL_DELAY_MS
    const backoffFactorRaw = process.env.WEBHOOK_RETRY_BACKOFF_FACTOR
    const maxDelayMsRaw = process.env.WEBHOOK_RETRY_MAX_DELAY_MS

    return {
      maxAttempts: maxAttemptsRaw ? parseInt(maxAttemptsRaw, 10) : 3,
      initialDelayMs: initialDelayMsRaw ? parseInt(initialDelayMsRaw, 10) : 1000,
      backoffFactor: backoffFactorRaw ? parseFloat(backoffFactorRaw) : 2,
      maxDelayMs: maxDelayMsRaw ? parseInt(maxDelayMsRaw, 10) : 10000
    }
  }

  private validateEmailRetryConfig(): EmailRetryConfig {
    const maxAttemptsRaw = process.env.EMAIL_RETRY_MAX_ATTEMPTS
    const initialDelayMsRaw = process.env.EMAIL_RETRY_INITIAL_DELAY_MS
    const backoffFactorRaw = process.env.EMAIL_RETRY_BACKOFF_FACTOR
    const maxDelayMsRaw = process.env.EMAIL_RETRY_MAX_DELAY_MS

    return {
      maxAttempts: maxAttemptsRaw ? parseInt(maxAttemptsRaw, 10) : 3,
      initialDelayMs: initialDelayMsRaw ? parseInt(initialDelayMsRaw, 10) : 1000,
      backoffFactor: backoffFactorRaw ? parseFloat(backoffFactorRaw) : 2,
      maxDelayMs: maxDelayMsRaw ? parseInt(maxDelayMsRaw, 10) : 10000
    }
  }

  private validateKmsConfig(): KmsConfig {
    const typeRaw = process.env.KMS_PROVIDER_TYPE ?? "env_var"
    if (!isKmsProviderType(typeRaw)) throw new Error("Invalid KMS_PROVIDER_TYPE. Allowed values: env_var")

    if (typeRaw === "env_var") {
      const currentVersionRaw = process.env.KMS_MASTER_KEY_ACTIVE_VERSION
      let currentVersion: number

      if (currentVersionRaw !== undefined) {
        const cleanVersion = currentVersionRaw.replace(/^v/i, "")
        currentVersion = parseInt(cleanVersion, 10)

        if (isNaN(currentVersion) || currentVersion <= 0) {
          throw new Error("KMS_MASTER_KEY_ACTIVE_VERSION must be a valid number greater than 0")
        }
      } else {
        currentVersion = 1
      }

      const keys = new Map<number, Buffer>()

      // Read and decode all key versions from environment (e.g., KMS_MASTER_KEY_V1, KMS_MASTER_KEY_V2)
      for (const [key, value] of Object.entries(process.env)) {
        const match = /^KMS_MASTER_KEY_V([0-9]+)$/.exec(key)
        if (match) {
          const rawVersion = match[1] ?? ""
          let version: number

          try {
            version = parseInt(rawVersion)
          } catch (error) {
            throw new Error("KMS_MASTER_KEY_VERSION must be a valid number", {cause: error})
          }

          if (value) {
            const keyBuffer = Buffer.from(value, "base64")
            if (keyBuffer.length !== 32)
              throw new Error(`KMS_MASTER_KEY for version ${version} must be a 32-byte (256-bit) key`)

            keys.set(version, keyBuffer)
            // Wipe from process.env immediately to reduce environment exposure
            delete process.env[key]
          }
        }
      }

      if (keys.size === 0)
        throw new Error(
          "No master keys provided. At least one KMS_MASTER_KEY_<VERSION> must be provided when KMS_PROVIDER_TYPE is env_var"
        )

      if (!keys.has(currentVersion))
        throw new Error(
          `KMS_MASTER_KEY_${currentVersion} (current version) must be provided when KMS_PROVIDER_TYPE is env_var`
        )

      let keysAccessed = false

      return {
        type: typeRaw,
        currentVersion,
        getKeys() {
          if (keysAccessed) throw new Error("KMS keys have already been read. Double consumption is not allowed.")

          keysAccessed = true
          return keys
        }
      }
    }

    throw new Error(`Unsupported KMS provider type: ${typeRaw}`)
  }

  private validateDatabaseRetryConfig(): DatabaseRetryConfig {
    const maxAttemptsRaw = process.env.DATABASE_RETRY_MAX_ATTEMPTS
    const initialDelayMsRaw = process.env.DATABASE_RETRY_INITIAL_DELAY_MS
    const backoffFactorRaw = process.env.DATABASE_RETRY_BACKOFF_FACTOR
    const maxDelayMsRaw = process.env.DATABASE_RETRY_MAX_DELAY_MS

    return {
      maxAttempts: maxAttemptsRaw ? parseInt(maxAttemptsRaw, 10) : 3,
      initialDelayMs: initialDelayMsRaw ? parseInt(initialDelayMsRaw, 10) : 1000,
      backoffFactor: backoffFactorRaw ? parseFloat(backoffFactorRaw) : 2,
      maxDelayMs: maxDelayMsRaw ? parseInt(maxDelayMsRaw, 10) : 10000
    }
  }
}
