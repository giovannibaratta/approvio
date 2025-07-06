import {Injectable} from "@nestjs/common"
import {Option} from "fp-ts/lib/Option"
import * as O from "fp-ts/lib/Option"

@Injectable()
export class ConfigProvider {
  readonly dbConnectionUrl: string
  readonly emailProviderConfig: Option<EmailProviderConfig>

  constructor() {
    this.dbConnectionUrl = this.validateConnectionUrl()
    this.emailProviderConfig = this.validateEmailProviderConfig()
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
}

export type EmailProviderConfig = GenericEmailProviderConfig

export interface GenericEmailProviderConfig {
  type: "generic"
  smtpUsername: string
  smtpPassword: string
  smtpEndpoint: string
  smtpPort: number
  allowSelfSignedCertificates: boolean
}
