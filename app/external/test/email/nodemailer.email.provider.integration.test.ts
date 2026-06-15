import {Email, EMAIL_EXTERNAL_TOKEN} from "@services/email"
import {MailpitClient} from "mailpit-api"
import {NodemailerEmailProvider} from "@external/email/email.provider"
import {Test, TestingModule} from "@nestjs/testing"
import {ThirdPartyModule} from "@external"

import {ConfigProvider} from "@external/config"
import {MockConfigProvider} from "@test/mock-data"
import {isNone} from "fp-ts/Option"
import {v7 as uuidv7} from "uuid"

/**
 * The integration test is based on the availability of Mailpit.
 * Mailpit is used to validate that the email was sent successfully.
 * This test requires the following environment variables to be set:
 * - MAILPIT_API_ENDPOINT: The endpoint of the Mailpit API.
 */

describe("NodemailerEmailProvider", () => {
  let mailpitEndpoint: string
  let emailProvider: NodemailerEmailProvider
  let senderUniqueTestIdentifier: string

  beforeEach(async () => {
    const originalEmailConfig = ConfigProvider.validateEmailProviderConfig()

    if (isNone(originalEmailConfig)) throw new Error("Email provider configuration is not valid.")

    const mailtpitEnvVariable = process.env.MAILPIT_API_ENDPOINT

    if (!mailtpitEnvVariable)
      throw new Error("MAILPIT_API_ENDPOINT environment variable is not set. This test requires Mailpit to be running.")

    mailpitEndpoint = mailtpitEnvVariable

    senderUniqueTestIdentifier = `${uuidv7()}@localhost.com`

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [ThirdPartyModule]
      })

        .overrideProvider(ConfigProvider)
        .useValue(
          MockConfigProvider.fromOriginalProvider({
            emailProviderConfig: {
              ...originalEmailConfig.value,
              senderEmail: senderUniqueTestIdentifier
            },
            emailRetryConfig: {
              maxAttempts: 3,
              initialDelayMs: 0,
              backoffFactor: 1,
              maxDelayMs: 0
            }
          })
        )
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    emailProvider = module.get(EMAIL_EXTERNAL_TOKEN)
    await cleanMailpitEmailInbox(mailpitEndpoint, `from:"${senderUniqueTestIdentifier}"`)
  })

  afterEach(async () => {
    await cleanMailpitEmailInbox(mailpitEndpoint, `from:"${senderUniqueTestIdentifier}"`)
  })

  it("should be defined", () => {
    expect(emailProvider).toBeDefined()
  })

  it("should send an email", async () => {
    // Given
    const email: Email = {
      to: "recipient123@localhost.com",
      subject: "Integration Test Email",
      htmlBody: "<h1>This is an integration test email</h1>"
    }

    // When
    const result = await emailProvider.sendEmail(email)()

    // Then
    expect(result).toBeRight()

    // Verify the email was captured by Mailpit
    const mailpit = new MailpitClient(`http://${mailpitEndpoint}`)
    const response = await mailpit.searchMessages({query: `from:"${senderUniqueTestIdentifier}"`})
    const messages = response.messages || []

    expect(messages).toHaveLength(1)
    const capturedEmail = messages[0]
    expect(capturedEmail?.To?.[0]?.Address).toBe(email.to)
  })

  it("should retry transient email sending errors and exhaust retries", async () => {
    // Given: An SMTP transient error (e.g. ECONNREFUSED)
    const mockError = new Error("Connection refused")
    Object.assign(mockError, {code: "ECONNREFUSED"})

    const sendMailSpy = jest.spyOn(emailProvider["transporter"]!, "sendMail").mockRejectedValue(mockError)

    const email: Email = {
      to: "recipient@localhost.com",
      subject: "Test Retry",
      htmlBody: "<h1>Test</h1>"
    }

    // When
    const result = await emailProvider.sendEmail(email)()

    // Then
    expect(result).toBeLeftOf("email_unknown_error")
    // Assert exactly 3 calls due to the retry mechanism
    expect(sendMailSpy).toHaveBeenCalledTimes(3)
  })

  it("should NOT retry non-transient email sending errors", async () => {
    // Given: A non-transient SMTP error (e.g. SMTP 550 Mailbox not found)
    const mockError = new Error("Mailbox not found")
    Object.assign(mockError, {responseCode: 550})

    const sendMailSpy = jest.spyOn(emailProvider["transporter"]!, "sendMail").mockRejectedValue(mockError)

    const email: Email = {
      to: "recipient@localhost.com",
      subject: "Test Retry",
      htmlBody: "<h1>Test</h1>"
    }

    // When
    const result = await emailProvider.sendEmail(email)()

    // Then
    expect(result).toBeLeftOf("email_unknown_error")
    // Assert only 1 call is made (no retries)
    expect(sendMailSpy).toHaveBeenCalledTimes(1)
  })
})

async function cleanMailpitEmailInbox(endpoint: string, search: string) {
  const mailpit = new MailpitClient(`http://${endpoint}`)
  try {
    await mailpit.deleteMessagesBySearch({query: search})
  } catch {
    // If no messages match or other error, we don't strictly care for cleanup
  }
}
