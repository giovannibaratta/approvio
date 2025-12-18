import {Email, EMAIL_EXTERNAL_TOKEN} from "@services/email"
import axios from "axios"
import {NodemailerEmailProvider} from "@external/email/email.provider"
import {Test, TestingModule} from "@nestjs/testing"
import {ThirdPartyModule} from "@external"
import {randomUUID} from "crypto"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider} from "@test/mock-data"
import {isNone} from "fp-ts/lib/Option"

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

    senderUniqueTestIdentifier = `${randomUUID()}@localhost.com`

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
            }
          })
        )
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    emailProvider = module.get(EMAIL_EXTERNAL_TOKEN)
    cleanMailpitEmailInbox(mailpitEndpoint, `from:"${senderUniqueTestIdentifier}"`)
  })

  afterEach(() => {
    cleanMailpitEmailInbox(mailpitEndpoint, `from:"${senderUniqueTestIdentifier}"`)
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
    const response = await axios.get(
      `http://${mailpitEndpoint}/api/v1/search?query=from:"${senderUniqueTestIdentifier}"`
    )
    const messages = response.data.messages

    expect(messages).toHaveLength(1)
    const capturedEmail = messages[0]
    expect(capturedEmail.To[0].Address).toBe(email.to)
  })
})

async function cleanMailpitEmailInbox(endpoint: string, search: string) {
  return await axios.delete(`http://${endpoint}/api/v1/search?query=${search}`)
}
