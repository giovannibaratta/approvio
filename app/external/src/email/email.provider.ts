import * as nodemailer from "nodemailer"
import {Email, EmailExternalError, EmailProviderExternal} from "@services"
import {Injectable, Logger} from "@nestjs/common"
import {ConfigProvider} from "@external/config"
import {EmailProviderConfig} from "@external/config/interfaces"
import {isNone, isSome, Option} from "fp-ts/Option"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {retryWithBackoff} from "@utils"

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

    const doSend = TE.tryCatch(
      async () => {
        await transporter.sendMail({
          from: emailProviderConfig.value.senderEmail,
          to: email.to,
          subject: email.subject,
          html: email.htmlBody
        })
      },
      (error: any) => {
        Logger.error("Failed to send email", error)

        // Nodemailer exposes an SMTP responseCode. 4xx is transient in SMTP.
        // It also can throw standard system errors like ECONNRESET, ETIMEDOUT, etc.
        const isTransient =
          (error.responseCode >= 400 && error.responseCode < 500) ||
          ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH'].includes(error.code)

        return {
          type: "email_unknown_error" as const,
          isTransient
        }
      }
    )

    return TE.mapLeft<{ type: EmailExternalError; isTransient: boolean }, EmailExternalError>(
      (err) => err.type
    )(
      retryWithBackoff(
        () => doSend,
        (error) => error.isTransient,
        {
          maxAttempts: 3,
          initialDelayMs: 1000,
          backoffFactor: 2,
          maxDelayMs: 10000
        }
      )
    )
  }
}
