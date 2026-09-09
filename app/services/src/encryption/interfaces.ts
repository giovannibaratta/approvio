import {TaskEither} from "fp-ts/TaskEither"
import {TenantContext} from "@domain"

export interface EncryptionContext extends TenantContext {
  readonly resourceType: "workflow_template" | "email_task" | "webhook_task" | "slack_task"
  readonly resourceId: string
  // TODO: Is the field type available only for specific resource type (E.g actions only for certain models, and payload for others) ? If this is the case, we should then pair then together and enforce this aspect.
  readonly field: "actions" | "payload"
  readonly formatVersion: 1
  // TODO: Do we need the key version or identifier ?
}

// TODO: What is a binding_mismatch error ?
export type CryptoError = "encryption_failed" | "decryption_failed" | "binding_mismatch" | "unsupported_format"

export interface TenantEncryption {
  encrypt(context: EncryptionContext, plaintext: string): TaskEither<CryptoError, string>
  decrypt(context: EncryptionContext, ciphertext: string): TaskEither<CryptoError, string>
  // TODO: What does it mean to reencrypt from a resource type workflow_template to a resource type email_task ?
  // Should we restrict the source & target to have the same params (either via the types or in the implementation) ?
  reencrypt(source: EncryptionContext, target: EncryptionContext, ciphertext: string): TaskEither<CryptoError, string>
}

// TODO: What is the rational for splitting the TenantEncryption from the PlatformEncryption ? Is it because the source of the key differs ? Please document
export interface PlatformEncryption {
  encryptPkce(state: string, providerConnectionId: string, plaintext: string): TaskEither<CryptoError, string>
  decryptPkce(state: string, providerConnectionId: string, ciphertext: string): TaskEither<CryptoError, string>
}
