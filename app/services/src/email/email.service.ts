import {Inject, Injectable} from "@nestjs/common"
import {EmailProviderExternal, EmailError, EMAIL_EXTERNAL_TOKEN, Email} from "./email.interface"
import {TaskEither} from "fp-ts/lib/TaskEither"
import * as TE from "fp-ts/lib/TaskEither"
import {isEmail} from "@utils"
import {pipe} from "fp-ts/lib/function"

@Injectable()
export class EmailService {
  constructor(@Inject(EMAIL_EXTERNAL_TOKEN) private readonly emailProvider: EmailProviderExternal) {}

  sendEmail(email: Email): TaskEither<EmailError, void> {
    const validate = (email: Email) => this.validateEmail(email)
    const send = (validatedEmail: Email) => this.emailProvider.sendEmail(validatedEmail)

    return pipe(email, TE.right, TE.chainW(validate), TE.chainW(send))
  }

  private validateEmail(email: Email): TaskEither<EmailError, Email> {
    const trimmedTo = Array.isArray(email.to) ? email.to.map(to => to.trim()) : [email.to.trim()]
    const trimmedSubject = email.subject?.trim() || undefined
    const trimmedBody = email.htmlBody.trim()

    if (trimmedTo.length === 0 || trimmedTo.some(to => !isEmail(to))) {
      return TE.left("email_invalid_to")
    }

    return TE.right({
      to: trimmedTo,
      subject: trimmedSubject,
      htmlBody: trimmedBody
    })
  }
}
