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

    if (!smtpUsername && !smtpPassword && !smtpEndpoint) {
      return O.none
    }

    if (!smtpUsername || !smtpPassword || !smtpEndpoint) {
      throw new Error("Incomplete email provider configuration")
    }

    if (smtpUsername.length === 0 || smtpPassword.length === 0 || smtpEndpoint.length === 0) {
      throw new Error("Email provider configuration values cannot be empty")
    }

    return O.some({
      type: "generic",
      smtpUsername,
      smtpPassword,
      smtpEndpoint
    })
  }
}

export type EmailProviderConfig = GenericEmailProviderConfig

export interface GenericEmailProviderConfig {
  type: "generic"
  smtpUsername: string
  smtpPassword: string
  smtpEndpoint: string
}
