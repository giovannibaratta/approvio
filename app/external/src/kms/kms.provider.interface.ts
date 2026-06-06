import {KeyringNode} from "@aws-crypto/client-node"

/**
 * Interface for KMS Providers.
 * Serves as the integration contract for the AWS Encryption SDK keyring.
 * High-level encryption/decryption operations are performed in another component,
 * keeping the KMS provider itself focused solely on keyring configuration and management.
 */
export interface KmsProvider {
  /** Returns a configured AWS Keyring */
  getKeyring(): KeyringNode
  /** Identifier for the current master key version */
  getCurrentKeyVersion(): number
}

export const KMS_PROVIDER_TOKEN = Symbol("KMS_PROVIDER_TOKEN")
