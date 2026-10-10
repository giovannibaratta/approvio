import {TaskEither} from "fp-ts/TaskEither"
import {TenantContext} from "@domain"

interface WorkflowTemplateEncryptionContext extends TenantContext {
  readonly resourceType: "workflow_template"
  readonly resourceId: string
  readonly field: "actions"
  readonly formatVersion: 1
}

interface TaskEncryptionContext extends TenantContext {
  readonly resourceType: "email_task" | "webhook_task" | "slack_task"
  readonly resourceId: string
  readonly field: "payload"
  readonly formatVersion: 1
}

export type EncryptionContext = WorkflowTemplateEncryptionContext | TaskEncryptionContext

/** Returned when ciphertext is valid but was produced for a different tenant/resource binding. */
export type CryptoError = "encryption_failed" | "decryption_failed" | "binding_mismatch" | "unsupported_format"

export interface TenantEncryption {
  encrypt(context: EncryptionContext, plaintext: string): TaskEither<CryptoError, string>
  decrypt(context: EncryptionContext, ciphertext: string): TaskEither<CryptoError, string>
  // Re-encryption is an explicit migration operation; the adapter validates both bindings and the
  // caller remains responsible for choosing a semantically valid source and target resource.
  reencrypt(source: EncryptionContext, target: EncryptionContext, ciphertext: string): TaskEither<CryptoError, string>
}

/**
 * Tenant encryption and platform encryption have separate trust scopes: tenant data is bound to an
 * organization/resource, while PKCE state is platform login data bound to a configured provider.
 */
export interface PlatformEncryption {
  encryptPkce(state: string, providerId: string, plaintext: string): TaskEither<CryptoError, string>
  decryptPkce(state: string, providerId: string, ciphertext: string): TaskEither<CryptoError, string>
}
