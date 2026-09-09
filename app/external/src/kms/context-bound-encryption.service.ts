import {Inject, Injectable} from "@nestjs/common"
import {buildClient, CommitmentPolicy} from "@aws-crypto/client-node"
import {createHash} from "node:crypto"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {CryptoError, EncryptionContext, PlatformEncryption, TenantEncryption} from "@services/encryption/interfaces"
import {isUUIDv7} from "@utils"
import {KMS_PROVIDER_TOKEN, KmsProvider} from "./kms.provider.interface"

const CIPHERTEXT_PREFIX = "approvio:enc:v1:"
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

// TODO: What is the Authenticated context ? document
type AuthenticatedContext = Readonly<Record<string, string>>

// TODO: Why not extending/refactoring the existing encryption service ? Do we still need it ?
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
        // TODO: What is the purpose of this check ? Can you explain and document it.
        if (!Object.entries(context).every(([key, value]) => authenticated[key] === value))
          return E.left("binding_mismatch")
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

// TODO: In this file there are several places where we return 'binding_mismatch'.
// this hide some of the context (fine) but we should log the reason why this was returned.
@Injectable()
export class TenantEncryptionService implements TenantEncryption {
  private readonly adapter: ContextEncryptionAdapter

  constructor(@Inject(KMS_PROVIDER_TOKEN) kmsProvider: KmsProvider) {
    this.adapter = new ContextEncryptionAdapter(kmsProvider)
  }

  encrypt(context: EncryptionContext, plaintext: string): TE.TaskEither<CryptoError, string> {
    // TODO: This can be refactored to be more fp-tsish by using the pipe
    const authenticatedContext = this.toAuthenticatedContext(context)
    return E.isLeft(authenticatedContext)
      ? TE.left(authenticatedContext.left)
      : this.adapter.encrypt(authenticatedContext.right, plaintext)
  }

  decrypt(context: EncryptionContext, ciphertext: string): TE.TaskEither<CryptoError, string> {
    // TODO: This can be refactored to be more fp-tsish by using the pipe
    const authenticatedContext = this.toAuthenticatedContext(context)
    return E.isLeft(authenticatedContext)
      ? TE.left(authenticatedContext.left)
      : this.adapter.decrypt(authenticatedContext.right, ciphertext)
  }

  reencrypt(
    source: EncryptionContext,
    target: EncryptionContext,
    ciphertext: string
  ): TE.TaskEither<CryptoError, string> {
    if (source.organizationId !== target.organizationId) return TE.left("binding_mismatch")
    return TE.chain((plaintext: string) => this.encrypt(target, plaintext))(this.decrypt(source, ciphertext))
  }

  private toAuthenticatedContext(context: EncryptionContext): E.Either<CryptoError, AuthenticatedContext> {
    if (context.formatVersion !== 1) return E.left("unsupported_format")
    if (!isUUIDv7(context.organizationId) || !isUUIDv7(context.resourceId)) return E.left("binding_mismatch")

    // TODO: If possible try to enforce via typing, if not possible we can keep it as it is.
    const fieldMatchesResource =
      (context.resourceType === "workflow_template" && context.field === "actions") ||
      (context.resourceType !== "workflow_template" && context.field === "payload")
    if (!fieldMatchesResource) return E.left("binding_mismatch")

    return E.right({
      scope: "tenant",
      organization_id: context.organizationId,
      resource_type: context.resourceType,
      resource_id: context.resourceId,
      field: context.field,
      format_version: String(context.formatVersion)
    })
  }
}

@Injectable()
export class PlatformEncryptionService implements PlatformEncryption {
  private readonly adapter: ContextEncryptionAdapter

  constructor(@Inject(KMS_PROVIDER_TOKEN) kmsProvider: KmsProvider) {
    this.adapter = new ContextEncryptionAdapter(kmsProvider)
  }

  encryptPkce(state: string, providerConnectionId: string, plaintext: string): TE.TaskEither<CryptoError, string> {
    // TODO: This can be refactored to be more fp-tsish by using the pipe
    const authenticatedContext = this.pkceContext(state, providerConnectionId)
    return E.isLeft(authenticatedContext)
      ? TE.left(authenticatedContext.left)
      : this.adapter.encrypt(authenticatedContext.right, plaintext)
  }

  decryptPkce(state: string, providerConnectionId: string, ciphertext: string): TE.TaskEither<CryptoError, string> {
    // TODO: This can be refactored to be more fp-tsish by using the pipe
    const authenticatedContext = this.pkceContext(state, providerConnectionId)
    return E.isLeft(authenticatedContext)
      ? TE.left(authenticatedContext.left)
      : this.adapter.decrypt(authenticatedContext.right, ciphertext)
  }

  private pkceContext(state: string, providerConnectionId: string): E.Either<CryptoError, AuthenticatedContext> {
    if (!state || !isUUIDv7(providerConnectionId)) return E.left("binding_mismatch")
    return E.right({
      scope: "platform_pkce",
      state_digest: createHash("sha256").update(state).digest("hex"),
      provider_connection_id: providerConnectionId,
      field: "verifier",
      format_version: "1"
    })
  }
}
