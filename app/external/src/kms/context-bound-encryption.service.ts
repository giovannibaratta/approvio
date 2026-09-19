import {Inject, Injectable} from "@nestjs/common"
import {buildClient, CommitmentPolicy} from "@aws-crypto/client-node"
import {createHash} from "node:crypto"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {CryptoError, EncryptionContext, PlatformEncryption, TenantEncryption} from "@services/encryption/interfaces"
import {isUUIDv5, isUUIDv7} from "@utils"
import {KMS_PROVIDER_TOKEN, KmsProvider} from "./kms.provider.interface"

const CIPHERTEXT_PREFIX = "approvio:enc:v1:"
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

// Authenticated context is the key-value metadata authenticated by the envelope encryption layer.
type AuthenticatedContext = TenantAuthenticatedContext | PkceAuthenticatedContext

interface TenantAuthenticatedContext {
  readonly scope: "tenant"
  readonly organization_id: EncryptionContext["organizationId"]
  readonly resource_type: EncryptionContext["resourceType"]
  readonly resource_id: string
  readonly field: EncryptionContext["field"]
  readonly format_version: "1"
}

interface PkceAuthenticatedContext {
  readonly scope: "platform_pkce"
  readonly state_digest: string
  readonly provider_id: string
  readonly field: "verifier"
  readonly format_version: "1"
}

// This adapter centralizes envelope handling
class ContextEncryptionAdapter {
  private readonly client = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT)

  constructor(private readonly kmsProvider: KmsProvider) {}

  encrypt(context: AuthenticatedContext, plaintext: string): TE.TaskEither<CryptoError, string> {
    return async () => {
      try {
        const {result} = await this.client.encrypt(this.kmsProvider.getKeyring(), plaintext, {
          encryptionContext: {
            ...context,
            key_version: String(this.kmsProvider.getCurrentKeyVersion())
          }
        })
        return E.right(`${CIPHERTEXT_PREFIX}${result.toString("base64")}`)
      } catch {
        return E.left("encryption_failed")
      }
    }
  }

  decrypt(context: AuthenticatedContext, ciphertext: string): TE.TaskEither<CryptoError, string> {
    return async () => {
      const encoded = this.parseCiphertext(ciphertext)
      if (E.isLeft(encoded)) return encoded

      try {
        const {plaintext, messageHeader} = await this.client.decrypt(this.kmsProvider.getKeyring(), encoded.right)
        const authenticated = messageHeader.encryptionContext
        if (!this.hasSupportedMetadata(authenticated)) return E.left("unsupported_format")
        // The SDK authenticates the metadata embedded in the ciphertext. Require it to match
        // the caller's expected context before returning plaintext, rejecting valid ciphertext
        // substituted from another organization, resource, field, or scope.
        // The caller must construct the expected context independently of the ciphertext metadata.
        // Authorization and the correctness of the expected tenant/resource remain upstream.
        if (!Object.entries(context).every(([key, value]) => authenticated[key] === value))
          return E.left("ciphertext_context_mismatch")
        return E.right(plaintext.toString("utf8"))
      } catch {
        return E.left("decryption_failed")
      }
    }
  }

  private parseCiphertext(ciphertext: string): E.Either<CryptoError, Buffer> {
    if (!ciphertext.startsWith(CIPHERTEXT_PREFIX)) return E.left("unsupported_format")
    const encoded = ciphertext.slice(CIPHERTEXT_PREFIX.length)
    if (!encoded || encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) return E.left("unsupported_format")
    return E.right(Buffer.from(encoded, "base64"))
  }

  private hasSupportedMetadata(context: Readonly<Record<string, string>>): boolean {
    return context.format_version === "1" && /^[1-9][0-9]*$/.test(context.key_version ?? "")
  }
}

@Injectable()
export class TenantEncryptionService implements TenantEncryption {
  private readonly adapter: ContextEncryptionAdapter

  constructor(@Inject(KMS_PROVIDER_TOKEN) kmsProvider: KmsProvider) {
    this.adapter = new ContextEncryptionAdapter(kmsProvider)
  }

  encrypt(context: EncryptionContext, plaintext: string): TE.TaskEither<CryptoError, string> {

    const authenticatedContext = this.toAuthenticatedContext(context)
    return E.isLeft(authenticatedContext)
      ? TE.left(authenticatedContext.left)
      : this.adapter.encrypt(authenticatedContext.right, plaintext)
  }

  decrypt(context: EncryptionContext, ciphertext: string): TE.TaskEither<CryptoError, string> {
    const authenticatedContext = this.toAuthenticatedContext(context)
    return E.isLeft(authenticatedContext)
      ? TE.left(authenticatedContext.left)
      : this.adapter.decrypt(authenticatedContext.right, ciphertext)
  }

  reencrypt<Source extends EncryptionContext>(
    source: Source,
    target: EncryptionContext & Pick<NoInfer<Source>, "resourceType" | "field">,
    ciphertext: string
  ): TE.TaskEither<CryptoError, string> {
    if (source.organizationId !== target.organizationId) return TE.left("cross_organization_reencryption_forbidden")
    if (source.resourceType !== target.resourceType || source.field !== target.field)
      return TE.left("incompatible_reencryption_context")
    return TE.chain((plaintext: string) => this.encrypt(target, plaintext))(this.decrypt(source, ciphertext))
  }

  private toAuthenticatedContext(context: EncryptionContext): E.Either<CryptoError, TenantAuthenticatedContext> {
    if (context.formatVersion !== 1) return E.left("unsupported_format")
    const fieldMatchesResource =
      context.resourceType === "workflow_template"
        ? context.field === "actions"
        : ["email_task", "webhook_task", "slack_task"].includes(context.resourceType) && context.field === "payload"
    if (!fieldMatchesResource) return E.left("invalid_encryption_context")
    const resourceIdIsValid =
      context.resourceType === "workflow_template" ? isUUIDv7(context.resourceId) : isUUIDv5(context.resourceId)
    if (!isUUIDv7(context.organizationId) || !resourceIdIsValid) return E.left("invalid_encryption_context")

    return E.right({
      scope: "tenant",
      organization_id: context.organizationId,
      resource_type: context.resourceType,
      resource_id: context.resourceId,
      field: context.field,
      format_version: "1"
    })
  }
}

@Injectable()
export class PlatformEncryptionService implements PlatformEncryption {
  private readonly adapter: ContextEncryptionAdapter

  constructor(@Inject(KMS_PROVIDER_TOKEN) kmsProvider: KmsProvider) {
    this.adapter = new ContextEncryptionAdapter(kmsProvider)
  }

  encryptPkce(state: string, providerId: string, plaintext: string): TE.TaskEither<CryptoError, string> {
    const authenticatedContext = this.pkceContext(state, providerId)
    return E.isLeft(authenticatedContext)
      ? TE.left(authenticatedContext.left)
      : this.adapter.encrypt(authenticatedContext.right, plaintext)
  }

  decryptPkce(state: string, providerId: string, ciphertext: string): TE.TaskEither<CryptoError, string> {
    const authenticatedContext = this.pkceContext(state, providerId)
    return E.isLeft(authenticatedContext)
      ? TE.left(authenticatedContext.left)
      : this.adapter.decrypt(authenticatedContext.right, ciphertext)
  }

  private pkceContext(state: string, providerId: string): E.Either<CryptoError, PkceAuthenticatedContext> {
    if (!state || providerId.trim().length === 0) return E.left("invalid_encryption_context")
    return E.right({
      scope: "platform_pkce",
      state_digest: createHash("sha256").update(state).digest("hex"),
      provider_id: providerId,
      field: "verifier",
      format_version: "1"
    })
  }
}
