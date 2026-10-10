import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {transactionContext} from "@external/database/transaction-context"
import {Either} from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {DeferredWorkflowTemplate} from "@services/workflow-template/interfaces"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {markTemplateForDeprecation, WorkflowTemplateFactory} from "@domain"
import {DatabaseClient} from "@external/database/database-client"
import {WorkflowTemplateTenantClient} from "@external/database/tenant-database-clients"
import {WorkflowTemplateDbRepository} from "@external/database/workflow-template.repository"
import {EnvVarKmsProvider} from "@external/kms/env-var-kms.provider"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("WorkflowTemplateDbRepository Integration", () => {
  let prisma: PrismaClient
  let database: DatabaseClient
  let encryption: TenantEncryptionService
  let repository: WorkflowTemplateDbRepository
  let organizationId: ReturnType<typeof toOrganizationId>

  beforeEach(async () => {
    const connectionString = await prepareDatabase()
    database = new DatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connectionString,
        platformConnectionUrl: connectionString,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    prisma = createFixturePrismaClient(connectionString)
    const key = Buffer.alloc(32, 7)
    encryption = new TenantEncryptionService(new EnvVarKmsProvider(new Map([[1, key]]), 1))
    repository = new WorkflowTemplateDbRepository(new WorkflowTemplateTenantClient(database), encryption)
    organizationId = randomOrgId()
    await prisma.organization.create({
      data: {
        id: organizationId,
        slug: `test-${organizationId}`,
        displayName: "Test organization",
        planTier: "FREE",
        status: "active",
        occ: 0n,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
  }, 30_000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await database.onModuleDestroy()
  })

  it("rejects a group removed after preparation before the write transaction", async () => {
    // Given: encryption preparation succeeds while the referenced group still exists.
    const context = {organizationId}
    const space = await createSpace(prisma, organizationId)
    const template = await createTemplate(prisma, organizationId, space.id, "Removed group", 1)
    const write = unwrapRight(await repository.createDeferredCreateExecution(context, template)())
    await prisma.group.deleteMany({where: {organizationId}})

    // When: the prepared write executes against the current database state.
    const result = await new PrismaTransactionManager(database).execute(context, write)()

    // Expect: the missing reference is rejected and no template is persisted.
    expect(result).toBeLeftOf("workflow_template_approval_group_not_found")
    expect(await prisma.workflowTemplate.count({where: {organizationId}})).toBe(0)
  })

  it("rejects a nested foreign-tenant group without deprecating the existing revision", async () => {
    // Given: a persisted template and a replacement whose nested rule mixes local and foreign groups.
    const context = {organizationId}
    const transactions = new PrismaTransactionManager(database)
    const space = await createSpace(prisma, organizationId)
    const original = await createTemplate(prisma, organizationId, space.id, "Invalid replacement", 1)
    const create = unwrapRight(await repository.createDeferredCreateExecution(context, original)())
    const persisted = unwrapRight(await transactions.execute(context, create)())
    const foreignId = randomOrgId()
    await prisma.organization.create({
      data: {
        id: foreignId,
        slug: `test-${foreignId}`,
        displayName: "Foreign",
        planTier: "FREE",
        status: "active",
        occ: 0n,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    const foreignSpace = await createSpace(prisma, foreignId)
    const foreign = await createTemplate(prisma, foreignId, foreignSpace.id, "Foreign", 1)
    const replacement = unwrapRight(
      WorkflowTemplateFactory.newWorkflowTemplate({
        ...original,
        version: 2,
        approvalRule: {type: "AND", rules: [original.approvalRule, foreign.approvalRule]}
      })
    )
    const deprecated = unwrapRight(markTemplateForDeprecation(persisted, false))
    const write = unwrapRight(
      await repository.createDeferredUpdateAndCreateExecution(context, {
        existingTemplate: {...deprecated, occ: persisted.occ},
        newTemplate: replacement
      })()
    )

    // When: deprecation and replacement run together in the caller's tenant transaction.
    const result = await transactions.execute(context, write)()

    // Expect: foreign groups are indistinguishable from missing groups; the entire mutation rolls back.
    expect(result).toBeLeftOf("workflow_template_approval_group_not_found")
    const unchanged = await prisma.workflowTemplate.findUniqueOrThrow({where: {id: persisted.id}})
    expect(unchanged.status).toBe(persisted.status)
    expect(unchanged.occ).toBe(persisted.occ)
    expect(await prisma.workflowTemplate.count({where: {organizationId, name: original.name}})).toBe(1)
  })

  it("reads tenant-scoped summary metadata without decrypting actions", async () => {
    const context = {organizationId}
    const transactions = new PrismaTransactionManager(database)
    const space = await createSpace(prisma, organizationId)
    const template = await createTemplate(prisma, organizationId, space.id, "Summary template", 1)
    const write = unwrapRight(await repository.createDeferredCreateExecution(context, template)())
    const created = unwrapRight(await transactions.execute(context, write)())
    await prisma.workflowTemplate.update({
      where: {id: created.id},
      data: {defaultExpiresInHours: 12, encActions: "unreadable ciphertext"}
    })
    const decrypt = jest.spyOn(encryption, "decrypt")
    try {
      const summary = unwrapRight(
        await transactions.execute(context, () => repository.getWorkflowTemplateSummaryById(context, created.id))()
      )
      expect(summary).toMatchObject({id: created.id, defaultExpiresInHours: 12})
      expect(summary).not.toHaveProperty("actions")
      expect(decrypt).not.toHaveBeenCalled()
      const missing = await transactions.execute(context, () =>
        repository.getWorkflowTemplateSummaryById(context, uuidv7())
      )()
      expect(missing).toBeLeftOf("workflow_template_not_found")
      const foreignContext = {organizationId: randomOrgId()}
      const foreign = await transactions.execute(foreignContext, () =>
        repository.getWorkflowTemplateSummaryById(foreignContext, created.id)
      )()
      expect(foreign).toBeLeftOf("workflow_template_not_found")
    } finally {
      decrypt.mockRestore()
    }
  })

  it("shares resolution only within one snapshot and keeps its OCC version", async () => {
    const context = {organizationId}
    const transactions = new PrismaTransactionManager(database)
    const space = await createSpace(prisma, organizationId)
    const template = await createTemplate(prisma, organizationId, space.id, "Cached snapshot", 1)
    const write = unwrapRight(await repository.createDeferredCreateExecution(context, template)())
    const created = unwrapRight(await transactions.execute(context, write)())
    const deferred = unwrapRight(
      await transactions.execute(context, () => repository.getWorkflowTemplateById(context, created.id))()
    )
    const decrypt = jest.spyOn(encryption, "decrypt")
    try {
      expect(decrypt).not.toHaveBeenCalled()
      const first = deferred.resolve()
      const concurrent = deferred.resolve()
      expect(concurrent).toBe(first)
      const resolved = unwrapRight(await first)
      expect(unwrapRight(await concurrent)).toBe(resolved)
      expect(unwrapRight(await deferred.resolve())).toBe(resolved)
      expect(decrypt).toHaveBeenCalledTimes(1)

      await prisma.workflowTemplate.update({where: {id: created.id}, data: {occ: {increment: 1}}})
      expect(unwrapRight(await deferred.resolve()).occ).toBe(created.occ)
      const staleWrite = unwrapRight(await repository.createDeferredUpdateExecution(context, resolved)())
      expect(await transactions.execute(context, staleWrite)()).toBeLeftOf("concurrency_error")

      const fresh = unwrapRight(
        await transactions.execute(context, () => repository.getWorkflowTemplateById(context, created.id))()
      )
      const freshTemplate = unwrapRight(await fresh.resolve())
      expect(freshTemplate).not.toBe(resolved)
      expect(freshTemplate.occ).toBe(created.occ + 1n)
      expect(decrypt).toHaveBeenCalledTimes(2)
    } finally {
      decrypt.mockRestore()
    }
  })

  it("retries a failed decryption on the same deferred object", async () => {
    const context = {organizationId}
    const transactions = new PrismaTransactionManager(database)
    const space = await createSpace(prisma, organizationId)
    const template = await createTemplate(prisma, organizationId, space.id, "Retry decryption", 1)
    const write = unwrapRight(await repository.createDeferredCreateExecution(context, template)())
    const created = unwrapRight(await transactions.execute(context, write)())
    const deferred = unwrapRight(
      await transactions.execute(context, () => repository.getWorkflowTemplateById(context, created.id))()
    )
    const decrypt = jest.spyOn(encryption, "decrypt").mockReturnValueOnce(TE.left("decryption_failed"))
    try {
      expect(await deferred.resolve()).toBeLeftOf("decryption_failed")
      const resolved = unwrapRight(await deferred.resolve())
      expect(resolved.actions).toEqual(template.actions)
      expect(unwrapRight(await deferred.resolve())).toBe(resolved)
      expect(decrypt).toHaveBeenCalledTimes(2)
    } finally {
      decrypt.mockRestore()
    }
  })

  it("prepares encrypted actions outside a transaction and executes writes without crypto", async () => {
    const context = {organizationId}
    const transactions = new PrismaTransactionManager(database)
    const space = await createSpace(prisma, organizationId)
    const template = await createTemplate(prisma, organizationId, space.id, "Prepared Template", 1)
    const encryptionScopes: boolean[] = []
    const encrypt = encryption.encrypt.bind(encryption)
    const encryptSpy = jest.spyOn(encryption, "encrypt").mockImplementation((binding, plaintext) => {
      encryptionScopes.push(transactionContext.getStore() !== undefined)
      return encrypt(binding, plaintext)
    })
    const decryptionScopes: boolean[] = []
    const decrypt = encryption.decrypt.bind(encryption)
    const decryptSpy = jest.spyOn(encryption, "decrypt").mockImplementation((binding, ciphertext) => {
      decryptionScopes.push(transactionContext.getStore() !== undefined)
      return decrypt(binding, ciphertext)
    })
    try {
      const create = unwrapRight(await repository.createDeferredCreateExecution(context, template)())
      const created = unwrapRight(await transactions.execute(context, create)())
      const deprecated = unwrapRight(markTemplateForDeprecation(created, false))
      const replacement = await createTemplate(prisma, organizationId, space.id, template.name, 2)
      const replace = unwrapRight(
        await repository.createDeferredUpdateAndCreateExecution(context, {
          existingTemplate: {...deprecated, occ: created.occ},
          newTemplate: replacement
        })()
      )
      expect(encryptionScopes).toEqual([false, false, false])
      const copied = unwrapRight(await transactions.execute(context, replace)())
      expect(copied.actions).toEqual(replacement.actions)
      // Re-executing the same prepared operation is fenced by OCC, not fresh encryption.
      expect(await transactions.execute(context, replace)()).toBeLeftOf("concurrency_error")
      expect(encryptSpy).toHaveBeenCalledTimes(3)
      expect(decryptSpy).not.toHaveBeenCalled()
      const byId = await materializeLoadedTemplate(
        await transactions.execute(context, () => repository.getWorkflowTemplateById(context, copied.id))()
      )
      const byVersion = await materializeLoadedTemplate(
        await transactions.execute(context, () =>
          repository.getWorkflowTemplateByNameAndVersion(context, copied.name, copied.version)
        )()
      )
      const active = await materializeLoadedTemplate(
        await transactions.execute(context, () => repository.getActiveWorkflowTemplateByName(context, copied.name))()
      )
      const nonActive = await materializeLoadedTemplate(
        await transactions.execute(context, () =>
          repository.getMostRecentNonActiveWorkflowTemplateByName(context, copied.name)
        )()
      )
      expect(byId.actions).toEqual(replacement.actions)
      expect(byVersion.id).toBe(copied.id)
      expect(active.id).toBe(copied.id)
      expect(nonActive).toMatchObject({_tag: "Some", value: {id: created.id}})
      expect(decryptionScopes).toEqual([false, false, false, false])
    } finally {
      encryptSpy.mockRestore()
      decryptSpy.mockRestore()
    }
  })

  it("rejects malformed encrypted actions and ciphertext substituted from another revision", async () => {
    const context = {organizationId}
    const transactions = new PrismaTransactionManager(database)
    const space = await createSpace(prisma, organizationId)
    const target = await createTemplate(prisma, organizationId, space.id, "Target Template", 1)
    const source = await createTemplate(prisma, organizationId, space.id, "Source Template", 1)
    const createTarget = unwrapRight(await repository.createDeferredCreateExecution(context, target)())
    const createSource = unwrapRight(await repository.createDeferredCreateExecution(context, source)())
    unwrapRight(await transactions.execute(context, createTarget)())
    unwrapRight(await transactions.execute(context, createSource)())

    // Privileged fixture corruption is separate from the restricted repository read.
    const malformed = unwrapRight(
      await encryption.encrypt(
        {
          organizationId,
          resourceType: "workflow_template",
          resourceId: target.id,
          field: "actions",
          formatVersion: 1
        },
        "{"
      )()
    )
    await prisma.workflowTemplate.update({where: {id: target.id}, data: {encActions: malformed}})
    const malformedRead = unwrapRight(
      await transactions.execute(context, () => repository.getWorkflowTemplateById(context, target.id))()
    )
    expect(await malformedRead.resolve()).toBeLeftOf("decryption_failed")

    const sourceRecord = await prisma.workflowTemplate.findUniqueOrThrow({where: {id: source.id}})
    await prisma.workflowTemplate.update({where: {id: target.id}, data: {encActions: sourceRecord.encActions}})
    const substitutedRead = unwrapRight(
      await transactions.execute(context, () => repository.getWorkflowTemplateById(context, target.id))()
    )
    expect(await substitutedRead.resolve()).toBeLeftOf("decryption_failed")
    const intactSource = await materializeLoadedTemplate(
      await transactions.execute(context, () => repository.getWorkflowTemplateById(context, source.id))()
    )
    expect(intactSource.actions).toEqual(source.actions)
  })

  it("rolls back the existing revision when creating its replacement conflicts", async () => {
    const context = {organizationId}
    const transactions = new PrismaTransactionManager(database)
    const space = await createSpace(prisma, organizationId)
    const template = await createTemplate(prisma, organizationId, space.id, "Rollback Template", 1)
    const create = unwrapRight(await repository.createDeferredCreateExecution(context, template)())
    const created = unwrapRight(await transactions.execute(context, create)())
    const before = await prisma.workflowTemplate.findUniqueOrThrow({where: {id: created.id}})
    const deprecated = unwrapRight(markTemplateForDeprecation(created, false))
    // Same name/version, new UUID: the second write violates the local unique constraint.
    const duplicate = await createTemplate(prisma, organizationId, space.id, template.name, 1)
    const replace = unwrapRight(
      await repository.createDeferredUpdateAndCreateExecution(context, {
        existingTemplate: {...deprecated, occ: created.occ},
        newTemplate: duplicate
      })()
    )
    const result = await transactions.execute(context, replace)()
    expect(result).toBeLeftOf("workflow_template_already_exists")
    expect(await prisma.workflowTemplate.findUniqueOrThrow({where: {id: created.id}})).toEqual(before)
    expect(await prisma.workflowTemplate.count({where: {organizationId}})).toBe(1)
    const unchanged = await materializeLoadedTemplate(
      await transactions.execute(context, () => repository.getWorkflowTemplateById(context, created.id))()
    )
    expect(unchanged.actions).toEqual(template.actions)
  })

  it("encrypts templates and scopes ID and name/version lookups to the organization", async () => {
    const context = {organizationId}
    const space = await createSpace(prisma, organizationId)
    const template = await createTemplate(prisma, organizationId, space.id, "Review Template", 1)
    const create = unwrapRight(await repository.createDeferredCreateExecution(context, template)())
    const created = unwrapRight(await database.transactional(organizationId, () => create()()))

    const raw = await prisma.workflowTemplate.findUnique({
      where: {organizationId_id: {organizationId, id: created.id}}
    })
    expect(raw?.encActions).toMatch(/^approvio:enc:v1:/)
    expect(raw?.encActions).not.toContain("approvio@example.test")

    const found = await materializeLoadedTemplate(
      await database.transactional(organizationId, () => repository.getWorkflowTemplateById(context, created.id)())
    )
    expect(found.actions).toEqual(template.actions)

    const deprecatedTemplate = unwrapRight(markTemplateForDeprecation(created, false))
    const revision = await createTemplate(prisma, organizationId, space.id, template.name, 2)
    const replace = unwrapRight(
      await repository.createDeferredUpdateAndCreateExecution(context, {
        existingTemplate: {...deprecatedTemplate, occ: created.occ},
        newTemplate: revision
      })()
    )
    const copiedRevision = unwrapRight(await database.transactional(organizationId, () => replace()()))
    expect(copiedRevision.actions).toEqual(template.actions)
    const count = unwrapRight(
      await database.transactional(organizationId, () =>
        repository.countUniqueWorkflowTemplatesBySpaceId(context, space.id)()
      )
    )
    expect(count).toBe(1)

    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({
      data: {
        id: otherOrganizationId,
        slug: `test-${otherOrganizationId}`,
        displayName: "Other organization",
        planTier: "FREE",
        status: "active",
        occ: 0n,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    const otherSpace = await createSpace(prisma, otherOrganizationId)
    const otherTemplate = await createTemplate(prisma, otherOrganizationId, otherSpace.id, template.name, 1)
    const otherCreate = unwrapRight(
      await repository.createDeferredCreateExecution({organizationId: otherOrganizationId}, otherTemplate)()
    )
    const otherCreated = unwrapRight(await database.transactional(otherOrganizationId, () => otherCreate()()))
    const sameNameAndVersion = await materializeLoadedTemplate(
      await database.transactional(otherOrganizationId, () =>
        repository.getWorkflowTemplateByNameAndVersion({organizationId: otherOrganizationId}, template.name, 1)()
      )
    )
    const activeByName = await materializeLoadedTemplate(
      await database.transactional(otherOrganizationId, () =>
        repository.getActiveWorkflowTemplateByName({organizationId: otherOrganizationId}, template.name)()
      )
    )
    expect(otherCreated.id).not.toBe(created.id)
    expect(sameNameAndVersion.id).toBe(otherCreated.id)
    expect(activeByName.id).toBe(otherCreated.id)

    const denied = await database.transactional(otherOrganizationId, () =>
      repository.getWorkflowTemplateById({organizationId: otherOrganizationId}, created.id)()
    )
    const foreignUpdate = await repository.createDeferredUpdateExecution(
      {organizationId: otherOrganizationId},
      created
    )()
    const scopedParents = unwrapRight(
      await database.transactional(otherOrganizationId, () =>
        repository.getWorkflowTemplatesParentsByNames({organizationId: otherOrganizationId}, [template.name])()
      )
    )
    const scopedList = unwrapRight(
      await database.transactional(otherOrganizationId, () =>
        repository.listWorkflowTemplates(
          {organizationId: otherOrganizationId},
          {
            pagination: {page: 1, limit: 10},
            search: template.name,
            searchMode: "EXACT",
            filters: {spaceId: otherSpace.id}
          }
        )()
      )
    )
    const contextB = {organizationId: otherOrganizationId}
    const transactions = new PrismaTransactionManager(database)
    const foreignOnly = await createTemplate(prisma, otherOrganizationId, otherSpace.id, "Foreign Only", 1)
    const createForeignOnly = unwrapRight(await repository.createDeferredCreateExecution(contextB, foreignOnly)())
    unwrapRight(await transactions.execute(contextB, createForeignOnly)())
    const foreignNameRead = await database.transactional(organizationId, () =>
      repository.getWorkflowTemplateByNameAndVersion(context, foreignOnly.name, 1)()
    )
    const mixedParents = await database.transactional(organizationId, () =>
      repository.getWorkflowTemplatesParentsByNames(context, [template.name, foreignOnly.name])()
    )
    const foreignParent = await database.transactional(otherOrganizationId, () =>
      repository.getParentSpace(contextB, created.id)()
    )
    const localParent = unwrapRight(
      await database.transactional(otherOrganizationId, () => repository.getParentSpace(contextB, otherCreated.id)())
    )
    const foreignSpaceCount = unwrapRight(
      await database.transactional(otherOrganizationId, () =>
        repository.countUniqueWorkflowTemplatesBySpaceId(contextB, space.id)()
      )
    )
    const noNonActive = await materializeLoadedTemplate(
      await database.transactional(otherOrganizationId, () =>
        repository.getMostRecentNonActiveWorkflowTemplateByName(contextB, template.name)()
      )
    )
    await prisma.space.update({where: {id: otherSpace.id}, data: {name: space.name}})
    const bySpaceName = unwrapRight(
      await database.transactional(otherOrganizationId, () =>
        repository.listWorkflowTemplates(contextB, {
          pagination: {page: 1, limit: 10},
          filters: {spaceName: space.name}
        })()
      )
    )
    const invalidLink = await createTemplate(prisma, otherOrganizationId, space.id, "Foreign Space Link", 1)
    const createInvalidLink = unwrapRight(await repository.createDeferredCreateExecution(contextB, invalidLink)())
    expect(await transactions.execute(contextB, createInvalidLink)()).toBeLeftOf("unknown_error")
    expect(await prisma.workflowTemplate.count({where: {id: invalidLink.id}})).toBe(0)
    expect(foreignNameRead).toBeLeftOf("workflow_template_not_found")
    expect(mixedParents).toBeLeftOf("workflow_template_not_found")
    expect(foreignParent).toBeLeftOf("workflow_template_not_found")
    expect(localParent).toBe(otherSpace.id)
    expect(foreignSpaceCount).toBe(0)
    expect(noNonActive).toEqual({_tag: "None"})
    expect(bySpaceName.templates.map(item => item.id).sort()).toEqual([otherCreated.id, foreignOnly.id].sort())
    expect(bySpaceName.pagination.total).toBe(2)
    expect(denied).toBeLeftOf("workflow_template_not_found")
    expect(foreignUpdate).toBeLeftOf("organization_mismatch")
    expect(scopedParents.get(template.name)).toBe(otherSpace.id)
    expect(scopedList.templates.map(item => item.id)).toEqual([otherCreated.id])
    expect(scopedList.pagination.total).toBe(1)
  })
})

async function createTemplate(
  prisma: PrismaClient,
  organizationId: string,
  spaceId: string,
  name: string,
  version: number
) {
  const groupId = uuidv7()
  await prisma.group.create({
    data: {
      id: groupId,
      organizationId,
      name: `group-${groupId}`,
      occ: 0n,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  })
  return unwrapRight(
    WorkflowTemplateFactory.newWorkflowTemplate({
      organizationId: toOrganizationId(organizationId),
      name,
      version,
      spaceId,
      approvalRule: {type: "GROUP_REQUIREMENT", groupId, minCount: 1},
      actions: [{type: "EMAIL", recipients: ["approvio@example.test"]}]
    })
  )
}

function createSpace(prisma: PrismaClient, organizationId: string) {
  const now = new Date()
  return prisma.space.create({
    data: {
      id: uuidv7(),
      organizationId,
      name: `space-${uuidv7()}`,
      description: null,
      occ: 0n,
      createdAt: now,
      updatedAt: now
    }
  })
}

async function materializeLoadedTemplate<Error extends string, Result>(
  loaded: Either<Error, DeferredWorkflowTemplate<Result>>
): Promise<Result> {
  return unwrapRight(await unwrapRight(loaded).resolve())
}
