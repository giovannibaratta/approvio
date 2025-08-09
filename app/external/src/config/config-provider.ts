import {Injectable} from "@nestjs/common"
import {Option} from "fp-ts/lib/Option"
import * as O from "fp-ts/lib/Option"
import {ConfigProviderInterface, EmailProviderConfig, OidcProviderConfig} from "./interfaces"

@Injectable()
export class ConfigProvider implements ConfigProviderInterface {
  readonly dbConnectionUrl: string
  readonly emailProviderConfig: Option<EmailProviderConfig>
  readonly oidcConfig: OidcProviderConfig

  constructor() {
    this.dbConnectionUrl = this.validateConnectionUrl()
    this.emailProviderConfig = this.validateEmailProviderConfig()
    this.oidcConfig = this.validateOidcProviderConfig()
  }

  private validateConnectionUrl(): string {
    const connectionUrl = process.env.DATABASE_URL

    if (connectionUrl === undefined) throw new Error("DATABASE_URL is not defined")

    return connectionUrl
  }

  private validateEmailProviderConfig(): Option<EmailProviderConfig> {
    const smtpUsername = process.env.SMTP_USERNAME
    const smtpPassword = process.env.SMTP_PASSWORD
    const smtpEndpoint = process.env.SMTP_ENDPOINT
    const unparsedSmtpPort = process.env.SMTP_PORT
    const unparsedAllowSelfSignedCertificates = process.env.SMTP_ALLOWED_SELF_SIGNED_CERTIFICATES

    if (!smtpUsername && !smtpPassword && !smtpEndpoint) {
      return O.none
    }

    if (!smtpUsername || !smtpPassword || !smtpEndpoint) {
      throw new Error("Incomplete email provider configuration")
    }

    if (smtpUsername.length === 0 || smtpPassword.length === 0 || smtpEndpoint.length === 0) {
      throw new Error("Email provider configuration values cannot be empty")
    }

    let smtpPort: number | undefined

    if (unparsedSmtpPort !== undefined) {
      try {
        smtpPort = parseInt(unparsedSmtpPort)
      } catch (error) {
        throw new Error("SMTP_PORT must be a valid number", {cause: error})
      }

      if (smtpPort <= 0 || smtpPort > 65535) {
        throw new Error("SMTP_PORT must be a valid number between 1 and 65535")
      }
    }

    let allowSelfSignedCertificates = false

    if (unparsedAllowSelfSignedCertificates !== undefined) {
      if (
        unparsedAllowSelfSignedCertificates.toLowerCase() !== "true" &&
        unparsedAllowSelfSignedCertificates.toLowerCase() !== "false"
      ) {
        throw new Error("SMTP_ALLOWED_SELF_SIGNED_CERTIFICATES must be 'true' or 'false'")
      }
      allowSelfSignedCertificates = unparsedAllowSelfSignedCertificates.toLowerCase() === "true"
    }

    return O.some({
      type: "generic",
      smtpUsername,
      smtpPassword,
      smtpEndpoint,
      smtpPort: smtpPort ?? 587,
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
}
