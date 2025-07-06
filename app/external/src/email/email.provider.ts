import * as nodemailer from "nodemailer"
import {Email, EmailExternalError, EmailProviderExternal} from "@services"
import {Injectable, Logger} from "@nestjs/common"
import {ConfigProvider} from "@external/config"
import {isSome} from "fp-ts/lib/Option"
import {TaskEither} from "fp-ts/lib/TaskEither"
import * as TE from "fp-ts/lib/TaskEither"

@Injectable()
export class NodemailerEmailProvider implements EmailProviderExternal {
  private readonly transporter: nodemailer.Transporter | undefined

  constructor(private readonly configService: ConfigProvider) {
    const config = this.configService.emailProviderConfig
    if (isSome(config)) {
      this.transporter = nodemailer.createTransport({
        host: config.value.smtpEndpoint,
        port: 587,
        secure: true,
        auth: {
          user: config.value.smtpUsername,
          pass: config.value.smtpPassword
        }
      })
    } else {
      Logger.warn("Email provider configuration is missing. The email provider will not be able to send emails.")
      this.transporter = undefined
    }
  }

  sendEmail(email: Email): TaskEither<EmailExternalError, void> {
    const transporter = this.transporter

    if (!transporter) {
      return TE.left("email_capability_not_configured")
    }

    return TE.tryCatch(
      async () => {
        await transporter.sendMail({
          from: email.from,
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
