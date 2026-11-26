import {Test, TestingModule} from "@nestjs/testing"
import {KMS_PROVIDER_TOKEN} from "@external/kms/kms.provider.interface"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {observeLogs} from "@test/log-observer"
import {buildClient, CommitmentPolicy} from "@aws-crypto/client-node"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"
import {v7 as uuidv7} from "uuid"
import {EncryptionContext} from "@services/encryption/interfaces"
import {generateDeterministicId} from "@utils/uuid"
import {PlatformEncryptionService, TenantEncryptionService} from "../../src/kms/context-bound-encryption.service"
import {EnvVarKmsProvider} from "../../src/kms/env-var-kms.provider"

function context(
  organizationId: ReturnType<typeof toOrganizationId>,
  resourceId: string,
  resourceType?: "workflow_template"
): Extract<EncryptionContext, {resourceType: "workflow_template"}>
function context<Type extends "email_task" | "webhook_task" | "slack_task">(
  organizationId: ReturnType<typeof toOrganizationId>,
  resourceId: string,
  resourceType: Type
): Extract<EncryptionContext, {field: "payload"}> & {resourceType: Type}
function context(
  organizationId: ReturnType<typeof toOrganizationId>,
  resourceId: string,
  resourceType: EncryptionContext["resourceType"] = "workflow_template"
): EncryptionContext {
  if (resourceType === "workflow_template")
    return {organizationId, resourceId, resourceType, field: "actions", formatVersion: 1}

  return {organizationId, resourceId, resourceType, field: "payload", formatVersion: 1}
}

describe("context-bound encryption", () => {
  const organizationA = randomOrgId()
  const organizationB = randomOrgId()
  const resourceA = uuidv7()
  const resourceB = uuidv7()
  const taskResourceA = generateDeterministicId("kms-task-resource-a")
  const taskResourceB = generateDeterministicId("kms-task-resource-b")
  const providerA = "custom"
  let module: TestingModule
  let tenantEncryption: TenantEncryptionService
  let platformEncryption: PlatformEncryptionService

  beforeEach(async () => {
    const provider = new EnvVarKmsProvider(new Map([[1, Buffer.alloc(32, 1)]]), 1)
    module = await Test.createTestingModule({
      providers: [TenantEncryptionService, PlatformEncryptionService, {provide: KMS_PROVIDER_TOKEN, useValue: provider}]
    }).compile()
    tenantEncryption = module.get(TenantEncryptionService)
    platformEncryption = module.get(PlatformEncryptionService)
  })

  afterEach(async () => {
    await module.close()
    jest.restoreAllMocks()
  })

  it("rejects ciphertext bound to another organization", async () => {
    // Given
    const encrypted = unwrapRight(await tenantEncryption.encrypt(context(organizationA, resourceA), "tenant secret")())

    // When
    const result = await tenantEncryption.decrypt(context(organizationB, resourceA), encrypted)()

    // Expect
    expect(result).toBeLeftOf("ciphertext_context_mismatch")
  })

  it("rejects a different task resource type with a valid resource ID", async () => {
    // Given
    const source = context(organizationA, taskResourceA, "email_task")
    const target = context(organizationA, taskResourceA, "webhook_task")
    const encrypted = unwrapRight(await tenantEncryption.encrypt(source, "tenant secret")())

    // When
    const result = await tenantEncryption.decrypt(target, encrypted)()

    // Expect
    expect(result).toBeLeftOf("ciphertext_context_mismatch")
  })

  it("distinguishes invalid resource IDs from ciphertext context mismatches", async () => {
    // Given
    const invalid = context(organizationA, resourceA, "email_task")

    // When
    const encrypted = await tenantEncryption.encrypt(invalid, "tenant secret")()
    const decrypted = await tenantEncryption.decrypt(invalid, "unused ciphertext")()

    // Expect
    expect(encrypted).toBeLeftOf("invalid_encryption_context")
    expect(decrypted).toBeLeftOf("invalid_encryption_context")
  })

  it("rejects ciphertext authenticated for the wrong field", async () => {
    // Given
    const client = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT)
    const provider = new EnvVarKmsProvider(new Map([[1, Buffer.alloc(32, 1)]]), 1)
    const {result} = await client.encrypt(provider.getKeyring(), "substituted payload", {
      encryptionContext: {
        scope: "tenant",
        organization_id: organizationA,
        resource_type: "workflow_template",
        resource_id: resourceA,
        field: "payload",
        format_version: "1",
        key_version: "1"
      }
    })

    // When
    const decrypted = await tenantEncryption.decrypt(
      context(organizationA, resourceA),
      `approvio:enc:v1:${result.toString("base64")}`
    )()

    // Expect
    expect(decrypted).toBeLeftOf("ciphertext_context_mismatch")
  })

  it("rejects substitution between tenant data and platform PKCE", async () => {
    // Given
    const binding = context(organizationA, resourceA)
    const tenantCiphertext = unwrapRight(await tenantEncryption.encrypt(binding, "tenant secret")())
    const platformCiphertext = unwrapRight(
      await platformEncryption.encryptPkce("opaque-state", providerA, "pkce verifier")()
    )

    // When
    const tenantResult = await tenantEncryption.decrypt(binding, platformCiphertext)()
    const platformResult = await platformEncryption.decryptPkce("opaque-state", providerA, tenantCiphertext)()

    // Expect
    expect(tenantResult).toBeLeftOf("ciphertext_context_mismatch")
    expect(platformResult).toBeLeftOf("ciphertext_context_mismatch")
  })

  it.each([
    ["", providerA],
    ["opaque-state", " "]
  ])("rejects invalid PKCE context (%s, %s)", async (state, providerId) => {
    // When
    const encrypted = await platformEncryption.encryptPkce(state, providerId, "pkce verifier")()
    const decrypted = await platformEncryption.decryptPkce(state, providerId, "unused ciphertext")()

    // Expect
    expect(encrypted).toBeLeftOf("invalid_encryption_context")
    expect(decrypted).toBeLeftOf("invalid_encryption_context")
  })

  it("rejects an unsupported requested context version", async () => {
    // Given
    const unsupported = context(organizationA, resourceA)
    Object.defineProperty(unsupported, "formatVersion", {value: 2})

    // When
    const result = await tenantEncryption.encrypt(unsupported, "tenant secret")()

    // Expect
    expect(result).toBeLeftOf("unsupported_format")
  })

  it("decrypts supported older key versions", async () => {
    // Given
    const binding = context(organizationA, resourceA)
    const versionOneProvider = new EnvVarKmsProvider(new Map([[1, Buffer.alloc(32, 1)]]), 1)
    const versionOne = new TenantEncryptionService(versionOneProvider)
    const encrypted = unwrapRight(await versionOne.encrypt(binding, "rotated secret")())

    const rotatedProvider = new EnvVarKmsProvider(
      new Map([
        [1, Buffer.alloc(32, 1)],
        [2, Buffer.alloc(32, 2)]
      ]),
      2
    )
    const rotated = new TenantEncryptionService(rotatedProvider)

    // When
    const result = await rotated.decrypt(binding, encrypted)()

    // Expect
    expect(result).toBeRightOf("rotated secret")
  })

  it("re-encrypts copies for a new immutable resource ID and forbids cross-organization copies", async () => {
    // Given
    const source = context(organizationA, taskResourceA, "webhook_task")
    const target = context(organizationA, taskResourceB, "webhook_task")
    const encrypted = unwrapRight(await tenantEncryption.encrypt(source, "copy secret")())

    // When
    const reencrypted = unwrapRight(await tenantEncryption.reencrypt(source, target, encrypted)())
    // Expect
    expect(await tenantEncryption.decrypt(source, reencrypted)()).toBeLeftOf("ciphertext_context_mismatch")
    expect(await tenantEncryption.decrypt(target, reencrypted)()).toBeRightOf("copy secret")

    // When
    const foreign = await tenantEncryption.reencrypt(
      source,
      context(organizationB, taskResourceB, "webhook_task"),
      encrypted
    )()

    // Expect
    expect(foreign).toBeLeftOf("cross_organization_reencryption_forbidden")
  })

  it("rejects re-encryption between task types", async () => {
    // Given
    const source = context(organizationA, taskResourceA, "email_task")
    const target = context(organizationA, taskResourceB, "webhook_task")

    // When
    // @ts-expect-error Re-encryption must preserve the task resource type.
    const result = await tenantEncryption.reencrypt(source, target, "unused ciphertext")()

    // Expect
    expect(result).toBeLeftOf("incompatible_reencryption_context")
  })

  it("rejects a changed field at runtime", async () => {
    // Given
    const source = context(organizationA, resourceA)
    const target = context(organizationA, resourceB)
    Object.defineProperty(target, "field", {value: "payload"})

    // When
    const result = await tenantEncryption.reencrypt(source, target, "unused ciphertext")()

    // Expect
    expect(result).toBeLeftOf("incompatible_reencryption_context")
  })

  it("re-encrypts template copies for their own resource ID", async () => {
    // Given
    const source = context(organizationA, resourceA)
    const target = context(organizationA, resourceB)
    const encrypted = unwrapRight(await tenantEncryption.encrypt(source, "template actions")())

    // When
    const copied = unwrapRight(await tenantEncryption.reencrypt(source, target, encrypted)())
    const targetResult = await tenantEncryption.decrypt(target, copied)()
    const sourceResult = await tenantEncryption.decrypt(source, copied)()

    // Expect
    expect(targetResult).toBeRightOf("template actions")
    expect(sourceResult).toBeLeftOf("ciphertext_context_mismatch")
  })

  it("rotates keys without changing the resource context", async () => {
    // Given
    const binding = context(organizationA, resourceA)
    const encrypted = unwrapRight(await tenantEncryption.encrypt(binding, "rotation secret")())
    const rotated = new TenantEncryptionService(
      new EnvVarKmsProvider(
        new Map([
          [1, Buffer.alloc(32, 1)],
          [2, Buffer.alloc(32, 2)]
        ]),
        2
      )
    )
    const currentKeyOnly = new TenantEncryptionService(new EnvVarKmsProvider(new Map([[2, Buffer.alloc(32, 2)]]), 2))

    // When
    const reencrypted = unwrapRight(await rotated.reencrypt(binding, binding, encrypted)())
    const result = await currentKeyOnly.decrypt(binding, reencrypted)()

    // Expect
    expect(result).toBeRightOf("rotation secret")
  })

  it("rejects PKCE ciphertext bound to another state", async () => {
    // Given
    const encrypted = unwrapRight(await platformEncryption.encryptPkce("opaque-state", providerA, "pkce verifier")())

    // When
    const result = await platformEncryption.decryptPkce("different-state", providerA, encrypted)()

    // Expect
    expect(result).toBeLeftOf("ciphertext_context_mismatch")
  })

  it("does not log plaintext, headers, tokens or secret URLs on failure", async () => {
    // Given
    const messages = observeLogs()
    const secret = "https://user:token@example.test/private?token=secret"

    const encrypted = unwrapRight(await tenantEncryption.encrypt(context(organizationA, resourceA), secret)())
    // When
    await tenantEncryption.decrypt(context(organizationB, resourceA), encrypted)()
    await tenantEncryption.decrypt(context(organizationA, resourceA), `${encrypted}corrupt`)()
    const corruptResult = await tenantEncryption.decrypt(
      context(organizationA, resourceA),
      `approvio:enc:v1:${Buffer.from("invalid encrypted message").toString("base64")}`
    )()

    // Expect
    const logged = messages.join(" ")
    expect(corruptResult).toBeLeftOf("decryption_failed")
    expect(logged).not.toContain(secret)
    expect(logged).not.toContain("token")
    expect(logged).not.toContain(encrypted)
  })
})
