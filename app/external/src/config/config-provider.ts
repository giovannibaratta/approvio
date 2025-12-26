import {Injectable} from "@nestjs/common"
import {Option} from "fp-ts/lib/Option"
import * as O from "fp-ts/lib/Option"
import {ConfigProviderInterface, EmailProviderConfig, JwtConfig, OidcProviderConfig, RedisConfig} from "./interfaces"
import {isEmail, isNonEmptyArray} from "@utils"

@Injectable()
export class ConfigProvider implements ConfigProviderInterface {
  readonly dbConnectionUrl: string
  readonly emailProviderConfig: Option<EmailProviderConfig>
  readonly oidcConfig: OidcProviderConfig
  readonly jwtConfig: JwtConfig
  readonly redisConfig: RedisConfig

  constructor() {
    this.dbConnectionUrl = this.validateConnectionUrl()
    this.emailProviderConfig = ConfigProvider.validateEmailProviderConfig()
    this.oidcConfig = this.validateOidcProviderConfig()
    this.jwtConfig = this.validateJwtConfig()
    this.redisConfig = this.validateRedisConfig()
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
    const issuerUrl = process.env.OIDC_ISSUER_URL
    const clientId = process.env.OIDC_CLIENT_ID
    const clientSecret = process.env.OIDC_CLIENT_SECRET
    const redirectUri = process.env.OIDC_REDIRECT_URI

    if (!issuerUrl || !clientId || !clientSecret || !redirectUri) {
      throw new Error("Incomplete OIDC provider configuration")
    }

    if (issuerUrl.length === 0 || clientId.length === 0 || clientSecret.length === 0 || redirectUri.length === 0) {
      throw new Error("OIDC provider configuration values cannot be empty")
    }

    // Validate URL format
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
      issuerUrl,
      clientId,
      clientSecret,
      redirectUri,
      allowInsecure
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
    const host = process.env.REDIS_HOST
    const unparsedPort = process.env.REDIS_PORT
    const unparsedDb = process.env.REDIS_DB || "0"
    const prefix = process.env.REDIS_PREFIX

    if (host === undefined) throw new Error("REDIS_HOST not defined")
    if (unparsedPort === undefined) throw new Error("REDIS_PORT is not defined")

    let port: number

    try {
      port = parseInt(unparsedPort, 10)
    } catch (error) {
      throw new Error("REDIS_PORT must be a valid number", {cause: error})
    }

    if (port <= 0 || port > 65535) throw new Error("REDIS_PORT must be a valid number between 1 and 65535")

    let db: number

    try {
      db = parseInt(unparsedDb, 10)
    } catch (error) {
      throw new Error("REDIS_DB must be a valid number", {cause: error})
    }

    if (db < 0 || db > 15) throw new Error("REDIS_DB must be a valid number between 0 and 15")

    return {
      host,
      port,
      db,
      prefix
    }
  }
}
