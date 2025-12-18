import * as nodemailer from "nodemailer"
import {Email, EmailExternalError, EmailProviderExternal} from "@services"
import {Injectable, Logger} from "@nestjs/common"
import {ConfigProvider} from "@external/config"
import {EmailProviderConfig} from "@external/config/interfaces"
import {isNone, isSome, Option} from "fp-ts/lib/Option"
import {TaskEither} from "fp-ts/lib/TaskEither"
import * as TE from "fp-ts/lib/TaskEither"

@Injectable()
export class NodemailerEmailProvider implements EmailProviderExternal {
  private readonly transporter: nodemailer.Transporter | undefined
  private readonly emailProviderConfig: Option<EmailProviderConfig>

  constructor(private readonly configService: ConfigProvider) {
    this.emailProviderConfig = this.configService.emailProviderConfig
    if (isSome(this.emailProviderConfig)) {
      this.transporter = nodemailer.createTransport({
        host: this.emailProviderConfig.value.smtpEndpoint,
        port: this.emailProviderConfig.value.smtpPort,
        secure: true,
        tls: {
          rejectUnauthorized: !this.emailProviderConfig.value.allowSelfSignedCertificates
        },
        auth: {
          user: this.emailProviderConfig.value.smtpUsername,
          pass: this.emailProviderConfig.value.smtpPassword
        }
      })
    } else {
      Logger.warn("Email provider configuration is missing. The email provider will not be able to send emails.")
      this.transporter = undefined
    }
  }

  sendEmail(email: Email): TaskEither<EmailExternalError, void> {
    const transporter = this.transporter
    const emailProviderConfig = this.emailProviderConfig

    if (!transporter || isNone(emailProviderConfig)) return TE.left("email_capability_not_configured")

    return TE.tryCatch(
      async () => {
        await transporter.sendMail({
          from: emailProviderConfig.value.senderEmail,
          to: email.to,
          subject: email.subject,
          html: email.htmlBody
        })
      },
      error => {
        Logger.error("Failed to send email", error)
        return "email_unknown_error" as const
      }
    )
  }
}
