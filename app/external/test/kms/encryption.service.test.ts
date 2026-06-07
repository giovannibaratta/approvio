import {unwrapRight} from "@utils/either"
import {EncryptionService} from "../../src/kms/encryption.service"
import {EnvVarKmsProvider} from "../../src/kms/env-var-kms.provider"

describe("EncryptionService", () => {
  let encryptionService: EncryptionService

  beforeEach(() => {
    const keyBytes = Buffer.alloc(32, 1)
    const provider = new EnvVarKmsProvider(new Map([[1, keyBytes]]), 1)
    encryptionService = new EncryptionService(provider)
  })

  it("should encrypt and decrypt string successfully", async () => {
    const plaintext = "my secret value"
    const ciphertextBase64 = unwrapRight(await encryptionService.encrypt(plaintext)())
    expect(ciphertextBase64).toBeDefined()
    expect(typeof ciphertextBase64).toBe("string")

    const decryptedPlaintext = unwrapRight(await encryptionService.decrypt(ciphertextBase64)())
    expect(decryptedPlaintext).toEqual(plaintext)
  })

  it("should encrypt and decrypt buffer successfully", async () => {
    const plaintext = Buffer.from("my secret value")
    const ciphertextBase64 = unwrapRight(await encryptionService.encrypt(plaintext)())

    // Simulate what Prisma extension gets: string from DB
    const decryptedPlaintext = unwrapRight(await encryptionService.decrypt(ciphertextBase64)())
    expect(decryptedPlaintext).toEqual(plaintext.toString("utf8"))
  })
})
