import {Injectable, Inject, Logger} from "@nestjs/common"
import {buildClient, CommitmentPolicy} from "@aws-crypto/client-node"
import {KmsProvider, KMS_PROVIDER_TOKEN} from "./kms.provider.interface"
import * as TE from "fp-ts/TaskEither"
import {EncryptionError} from "@services/error"

@Injectable()
export class EncryptionService {
  private readonly client = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT)

  constructor(@Inject(KMS_PROVIDER_TOKEN) private readonly kmsProvider: KmsProvider) {}

  /**
   * Encrypts the plaintext using the current KMS provider keyring.
   * Returns a base64 encoded ciphertext string wrapped in a TaskEither.
   */
  encrypt(plaintext: string | Buffer): TE.TaskEither<EncryptionError, string> {
    return TE.tryCatch(
      async () => {
        const {result} = await this.client.encrypt(this.kmsProvider.getKeyring(), plaintext)
        return result.toString("base64")
      },
      error => {
        Logger.error("Error encrypting data", error)
        return "encryption_failed" as const
      }
    )
  }

  /**
   * Decrypts the given ciphertext string (base64) or Buffer using the KMS provider keyring.
   * Returns the decrypted string (utf8) wrapped in a TaskEither.
   */
  decrypt(ciphertext: string | Buffer): TE.TaskEither<EncryptionError, string> {
    return TE.tryCatch(
      async () => {
        const buffer = typeof ciphertext === "string" ? Buffer.from(ciphertext, "base64") : ciphertext
        const {plaintext} = await this.client.decrypt(this.kmsProvider.getKeyring(), buffer)
        return plaintext.toString("utf8")
      },
      error => {
        Logger.error("Error decrypting data", error)
        return "decryption_failed" as const
      }
    )
  }
}
