import {EnvVarKmsProvider} from "../../src/kms/env-var-kms.provider"
import {MultiKeyringNode} from "@aws-crypto/client-node"
import {ConfigProvider} from "../../src/config/config-provider"

describe("EnvVarKmsProvider", () => {
  it("should create a provider successfully with valid 32-byte master keys", () => {
    const keyBytes1 = Buffer.alloc(32, 1)
    const keyBytes2 = Buffer.alloc(32, 2)

    const provider = new EnvVarKmsProvider(
      new Map([
        [1, keyBytes1],
        [2, keyBytes2]
      ]),
      2
    )

    expect(provider.getCurrentKeyVersion()).toBe(2)
    expect(provider.getKeyring()).toBeInstanceOf(MultiKeyringNode)

    // Verify key bytes were zeroed out
    expect(keyBytes1.equals(Buffer.alloc(32, 0))).toBe(true)
    expect(keyBytes2.equals(Buffer.alloc(32, 0))).toBe(true)
  })

  it("should throw an error if any key is not 32 bytes", () => {
    const keyBytesValid = Buffer.alloc(32, 1)
    const keyBytesInvalid = Buffer.alloc(16, 2)

    expect(
      () =>
        new EnvVarKmsProvider(
          new Map([
            [1, keyBytesValid],
            [2, keyBytesInvalid]
          ]),
          1
        )
    ).toThrow("Master key must be 32 bytes")
  })

  it("should throw an error if current key version is not specified", () => {
    const keyBytes = Buffer.alloc(32, 1)

    expect(() => new EnvVarKmsProvider(new Map([[1, keyBytes]]), 0)).toThrow("Current key version must be specified")
  })

  it("should throw an error if current key version is not found in keys dictionary", () => {
    const keyBytes = Buffer.alloc(32, 1)

    expect(() => new EnvVarKmsProvider(new Map([[1, keyBytes]]), 2)).toThrow(
      "Current key version 2 not found in keys dictionary"
    )
  })
})

describe("ConfigProvider KmsConfig", () => {
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = {...process.env}
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("should throw an error on double invocation of getKeys()", () => {
    process.env.KMS_PROVIDER_TYPE = "env_var"
    process.env.KMS_MASTER_KEY_V1 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
    process.env.KMS_MASTER_KEY_ACTIVE_VERSION = "v1"

    const config = new ConfigProvider()
    const keys1 = config.kmsConfig.getKeys()
    expect(keys1.get(1)).toBeDefined()

    expect(() => config.kmsConfig.getKeys()).toThrow(
      "KMS keys have already been read. Double consumption is not allowed."
    )
  })
})
