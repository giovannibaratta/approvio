import {KeyringNode, RawAesKeyringNode, MultiKeyringNode, RawAesWrappingSuiteIdentifier} from "@aws-crypto/client-node"
import {KmsProvider} from "./kms.provider.interface"

export class EnvVarKmsProvider implements KmsProvider {
  private readonly keyring: KeyringNode
  private readonly version: number

  constructor(keys: Map<number, Buffer>, currentVersion: number) {
    if (!keys || keys.size === 0) throw new Error("At least one master key must be provided")

    if (!currentVersion) throw new Error("Current key version must be specified")

    const currentKeyBuffer = keys.get(currentVersion)
    if (!currentKeyBuffer) throw new Error(`Current key version ${currentVersion} not found in keys dictionary`)

    const childKeyrings: RawAesKeyringNode[] = []
    let generatorKeyring: RawAesKeyringNode | undefined

    for (const [version, unencryptedMasterKey] of keys.entries()) {
      if (unencryptedMasterKey.length !== 32) throw new Error("Master key must be 32 bytes (256 bits)")

      // The AWS Encryption SDK requires the unencrypted master key to be in an isolated buffer
      // with byteOffset === 0 (enforced by a precondition check in decorateCryptographicMaterial).
      // Slices from Node's shared Buffer pool often have a non-zero byteOffset, so we copy the
      // key into a newly allocated Buffer to satisfy this requirement.
      //
      // Note on memory destruction and key exposure:
      // 1. The AWS SDK's wrapWithKeyObjectIfSupported immediately wraps the passed buffer inside
      //    a Node.js cryptographic KeyObject and zeroes out that specific binary buffer via
      //    dataKey.fill(0).
      // 2. However, the key material still exists in the application process as standard base64
      //    strings in process.env and the ConfigProvider's keys record.
      // 3. Once initialized, the wrapped key inside the keyring is held privately inside closures
      //    and cannot be re-extracted.
      const isolatedMasterKey = Buffer.alloc(32)
      unencryptedMasterKey.copy(isolatedMasterKey)

      const keyName = `env-var-master-key-${version}`
      const keyNamespace = "env-var-kms"

      const keyring = new RawAesKeyringNode({
        keyName,
        keyNamespace,
        unencryptedMasterKey: isolatedMasterKey,
        wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING
      })

      childKeyrings.push(keyring)

      if (version === currentVersion) generatorKeyring = keyring
    }

    if (!generatorKeyring)
      throw new Error(`Generator keyring for active version ${currentVersion} could not be initialized`)

    // Combine all keyrings using a MultiKeyringNode.
    // The generator keyring is used to encrypt new data, while the children keyrings
    // (all keyrings) are used to decrypt data encrypted with previous keys.
    this.keyring = new MultiKeyringNode({
      generator: generatorKeyring,
      children: childKeyrings
    })
    this.version = currentVersion

    // Zero out the key buffers in the keys record to securely destroy the secrets in memory
    // TODO (long-term): extend the ConfigProvider to build a MasterKeyManager that will take care
    // of zeroing out the keys on the first read. This will avoid to replicate this logic in every KMS Provider
    for (const keyBuffer of keys.values()) keyBuffer.fill(0)
  }

  getKeyring(): KeyringNode {
    return this.keyring
  }

  getCurrentKeyVersion(): number {
    return this.version
  }
}
