import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {Logger} from "@nestjs/common"
import * as E from "fp-ts/Either"
import {v7 as uuidv7} from "uuid"
import {EncryptionContext} from "@services/encryption/interfaces"
import {generateDeterministicId} from "@utils/uuid"
import {PlatformEncryptionService, TenantEncryptionService} from "../../src/kms/context-bound-encryption.service"
import {EncryptionService} from "../../src/kms/encryption.service"
import {EnvVarKmsProvider} from "../../src/kms/env-var-kms.provider"

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
  const providerB = "okta"
  let tenantEncryption: TenantEncryptionService
  let platformEncryption: PlatformEncryptionService
  let legacyEncryption: EncryptionService

  beforeEach(() => {
    const provider = new EnvVarKmsProvider(new Map([[1, Buffer.alloc(32, 1)]]), 1)
    tenantEncryption = new TenantEncryptionService(provider)
    platformEncryption = new PlatformEncryptionService(provider)
    legacyEncryption = new EncryptionService(provider)
  })

  it("round-trips with the exact tenant binding", async () => {
    const binding = context(organizationA, resourceA)
    const encrypted = await tenantEncryption.encrypt(binding, "tenant secret")()
    expect(E.isRight(encrypted)).toBe(true)
    if (E.isLeft(encrypted)) return

    expect(await tenantEncryption.decrypt(binding, encrypted.right)()).toEqual(E.right("tenant secret"))
  })

  it.each([
    ["organization", context(organizationB, resourceA)],
    ["resource", context(organizationA, resourceB)],
    ["field and resource type", context(organizationA, resourceA, "email_task")]
  ])("rejects a wrong %s binding", async (_label, wrongBinding) => {
    const encrypted = await tenantEncryption.encrypt(context(organizationA, resourceA), "tenant secret")()
    if (E.isLeft(encrypted)) throw new Error(encrypted.left)

    expect(await tenantEncryption.decrypt(wrongBinding, encrypted.right)()).toEqual(E.left("binding_mismatch"))
  })

  it("rejects malformed and legacy unbound ciphertext", async () => {
    const binding = context(organizationA, resourceA)
    expect(await tenantEncryption.decrypt(binding, "not-a-versioned-ciphertext")()).toEqual(
      E.left("unsupported_format")
    )
    expect(await tenantEncryption.decrypt(binding, "approvio:enc:v1:not-base64")()).toEqual(
      E.left("unsupported_format")
    )

    const legacy = await legacyEncryption.encrypt("legacy secret")()
    if (E.isLeft(legacy)) throw new Error(legacy.left)
    expect(await tenantEncryption.decrypt(binding, legacy.right)()).toEqual(E.left("unsupported_format"))
  })

  it("rejects an unsupported requested context version", async () => {
    const unsupported = context(organizationA, resourceA)
    Object.defineProperty(unsupported, "formatVersion", {value: 2})
    expect(await tenantEncryption.encrypt(unsupported, "tenant secret")()).toEqual(E.left("unsupported_format"))
  })

  it("decrypts supported older key versions", async () => {
    const binding = context(organizationA, resourceA)
    const versionOneProvider = new EnvVarKmsProvider(new Map([[1, Buffer.alloc(32, 1)]]), 1)
    const versionOne = new TenantEncryptionService(versionOneProvider)
    const encrypted = await versionOne.encrypt(binding, "rotated secret")()
    if (E.isLeft(encrypted)) throw new Error(encrypted.left)

    const rotatedProvider = new EnvVarKmsProvider(
      new Map([
        [1, Buffer.alloc(32, 1)],
        [2, Buffer.alloc(32, 2)]
      ]),
      2
    )
    const rotated = new TenantEncryptionService(rotatedProvider)
    expect(await rotated.decrypt(binding, encrypted.right)()).toEqual(E.right("rotated secret"))
  })

  it("re-encrypts copies for a new immutable resource ID and forbids cross-organization copies", async () => {
    const source = context(organizationA, taskResourceA, "webhook_task")
    const target = context(organizationA, taskResourceB, "webhook_task")
    const encrypted = await tenantEncryption.encrypt(source, "copy secret")()
    if (E.isLeft(encrypted)) throw new Error(encrypted.left)

    const reencrypted = await tenantEncryption.reencrypt(source, target, encrypted.right)()
    if (E.isLeft(reencrypted)) throw new Error(reencrypted.left)
    expect(await tenantEncryption.decrypt(source, reencrypted.right)()).toEqual(E.left("binding_mismatch"))
    expect(await tenantEncryption.decrypt(target, reencrypted.right)()).toEqual(E.right("copy secret"))

    expect(
      await tenantEncryption.reencrypt(source, context(organizationB, resourceB, "webhook_task"), encrypted.right)()
    ).toEqual(E.left("binding_mismatch"))
  })

  it("binds platform PKCE ciphertext to state and configured provider", async () => {
    const encrypted = await platformEncryption.encryptPkce("opaque-state", providerA, "pkce verifier")()
    if (E.isLeft(encrypted)) throw new Error(encrypted.left)

    expect(await platformEncryption.decryptPkce("opaque-state", providerA, encrypted.right)()).toEqual(
      E.right("pkce verifier")
    )
    expect(await platformEncryption.decryptPkce("different-state", providerA, encrypted.right)()).toEqual(
      E.left("binding_mismatch")
    )
    expect(await platformEncryption.decryptPkce("opaque-state", providerB, encrypted.right)()).toEqual(
      E.left("binding_mismatch")
    )
  })

  it("does not log plaintext, headers, tokens or secret URLs on failure", async () => {
    const error = jest.spyOn(Logger, "error").mockImplementation()
    const warn = jest.spyOn(Logger, "warn").mockImplementation()
    const log = jest.spyOn(Logger, "log").mockImplementation()
    const secret = "https://user:token@example.test/private?token=secret"

    const encrypted = await tenantEncryption.encrypt(context(organizationA, resourceA), secret)()
    if (E.isLeft(encrypted)) throw new Error(encrypted.left)
    await tenantEncryption.decrypt(context(organizationB, resourceA), encrypted.right)()
    await tenantEncryption.decrypt(context(organizationA, resourceA), `${encrypted.right}corrupt`)()

    const logged = [...error.mock.calls, ...warn.mock.calls, ...log.mock.calls].flat().join(" ")
    expect(logged).not.toContain(secret)
    expect(logged).not.toContain("token")
    expect(logged).not.toContain(encrypted.right)

    error.mockRestore()
    warn.mockRestore()
    log.mockRestore()
  })
})
