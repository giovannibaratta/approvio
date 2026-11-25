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

export type CryptoError =
  | "encryption_failed"
  | "decryption_failed"
  /** Authenticated ciphertext metadata differs from the requested tenant/resource or PKCE context. */
  | "ciphertext_context_mismatch"
  /** Invalid identifiers, resource/field combinations, or empty PKCE state/provider. */
  | "invalid_encryption_context"
  /** Re-encryption cannot transfer ciphertext between organizations. */
  | "cross_organization_reencryption_forbidden"
  /** Re-encryption preserves payload meaning and cannot change resource type or field. */
  | "incompatible_reencryption_context"
  | "unsupported_format"

export interface TenantEncryption {
  encrypt(context: EncryptionContext, plaintext: string): TaskEither<CryptoError, string>
  decrypt(context: EncryptionContext, ciphertext: string): TaskEither<CryptoError, string>
  // Copies may change resource ID; key rotation may retain it. Organization, resource type and field must match.
  reencrypt<Source extends EncryptionContext>(
    source: Source,
    target: EncryptionContext & Pick<NoInfer<Source>, "resourceType" | "field">,
    ciphertext: string
  ): TaskEither<CryptoError, string>
}

/**
 * Tenant encryption and platform encryption have separate trust scopes: tenant data is bound to an
 * organization/resource, while PKCE state is platform login data bound to a configured provider.
 */
export interface PlatformEncryption {
  encryptPkce(state: string, providerId: string, plaintext: string): TaskEither<CryptoError, string>
  decryptPkce(state: string, providerId: string, ciphertext: string): TaskEither<CryptoError, string>
}
