import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {ConfigModule, KmsModule} from "@external"
import {TenantContext, WorkflowActionType, WorkflowTemplate, WorkflowTemplateFactory} from "@domain"
import {DATABASE_RUNTIME_ROLE_TOKEN, DatabaseClient} from "@external/database/database-client"
import {WorkflowTemplateTenantClient} from "@external/database/tenant-database-clients"
import {WorkflowTemplateDbRepository} from "@external/database/workflow-template.repository"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider, createMockSpaceInDb, createMockWorkflowTemplateDomain} from "@test/mock-data"
import {randomOrgId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"
import * as TE from "fp-ts/TaskEither"
import "@utils/matchers"

describe("WorkflowTemplateDbRepository Integration", () => {
  let prisma: PrismaClient
  let module: TestingModule
  let transactions: PrismaTransactionManager
  let encryption: TenantEncryptionService
  let repository: WorkflowTemplateDbRepository
  let context: TenantContext
  let template: WorkflowTemplate

  beforeEach(async () => {
    const connection = await prepareDatabase()
    module = await Test.createTestingModule({
      imports: [ConfigModule, KmsModule],
      providers: [
        WorkflowTemplateDbRepository,
        DatabaseClient,
        WorkflowTemplateTenantClient,
        PrismaTransactionManager,
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_tenant_runtime"}
      ]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromTenantConnectionUrl(connection))
      .compile()
    repository = module.get(WorkflowTemplateDbRepository)
    transactions = module.get(PrismaTransactionManager)
    encryption = module.get(TenantEncryptionService)
    await module.init()
    prisma = createFixturePrismaClient(connection)

    context = {organizationId: randomOrgId()}
    const space = await createMockSpaceInDb(prisma, context)
    template = createMockWorkflowTemplateDomain({
      organizationId: context.organizationId,
      spaceId: space.id,
      actions: [{type: WorkflowActionType.EMAIL, recipients: ["approvio@example.test"]}]
    })
  }, 30000)

  afterEach(async () => {
    jest.restoreAllMocks()
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await module.close()
  })

  async function persistTemplate() {
    const write = unwrapRight(await repository.createDeferredCreateExecution(context, template)())
    return unwrapRight(await transactions.execute(context, write)())
  }

  it("rejects a template belonging to another organization without persisting it", async () => {
    // Given: bypass HTTP admission with a valid domain object carrying a foreign organization.
    const foreign = unwrapRight(WorkflowTemplateFactory.validate({...template, organizationId: randomOrgId()}))
    const write = unwrapRight(await repository.createDeferredCreateExecution(context, foreign)())

    // When
    const result = await transactions.execute(context, write)()

    // Expect
    expect(result).toBeLeftOf("unknown_error")
    expect(await prisma.workflowTemplate.count()).toBe(0)
  })

  it("decrypts each fetched template once and rejects writes from a cached template after its database version changes", async () => {
    // Given: a deferred read holds the template data and OCC version fetched from the database.
    const created = await persistTemplate()
    const deferred = unwrapRight(
      await transactions.execute(context, () => repository.getWorkflowTemplateById(context, created.id))()
    )
    const decrypt = jest.spyOn(encryption, "decrypt")

    // When: two callers resolve the same fetched template.
    const first = deferred.resolve()
    const concurrent = deferred.resolve()
    const resolved = unwrapRight(await first)

    // Expect: both callers share one decryption operation.
    expect(concurrent).toBe(first)
    expect(decrypt).toHaveBeenCalledTimes(1)

    // When: another write advances the database version, then the cached template is resolved again.
    await prisma.workflowTemplate.update({where: {id: created.id}, data: {occ: {increment: 1}}})
    const cached = unwrapRight(await deferred.resolve())

    // Expect: resolution reuses the cached object; it must not silently fetch a newer version.
    expect(cached).toBe(resolved)
    expect(cached.occ).toBe(created.occ)
    expect(decrypt).toHaveBeenCalledTimes(1)

    // When: the caller tries to persist that stale object.
    const staleWrite = unwrapRight(await repository.createDeferredUpdateExecution(context, resolved)())
    const result = await transactions.execute(context, staleWrite)()

    // Expect: preserving the fetched OCC version prevents overwriting the intervening write.
    expect(result).toBeLeftOf("concurrency_error")

    // When: a new read fetches and resolves the updated template.
    const fresh = unwrapRight(
      await transactions.execute(context, () => repository.getWorkflowTemplateById(context, created.id))()
    )
    const updated = unwrapRight(await fresh.resolve())

    // Expect: this read has its own decryption result and the current OCC version.
    expect(updated).not.toBe(resolved)
    expect(updated.occ).toBe(created.occ + 1n)
    expect(decrypt).toHaveBeenCalledTimes(2)
  })

  it("allows retrying resolution after a decryption failure", async () => {
    // Given
    const created = await persistTemplate()
    const deferred = unwrapRight(
      await transactions.execute(context, () => repository.getWorkflowTemplateById(context, created.id))()
    )
    const decrypt = jest.spyOn(encryption, "decrypt").mockReturnValueOnce(TE.left("decryption_failed"))

    // When: the first decryption fails.
    const failed = await deferred.resolve()

    // Expect
    expect(failed).toBeLeftOf("decryption_failed")

    // When: the caller retries resolution on the same deferred object.
    const retried = await deferred.resolve()

    // Expect: the failure was not cached, so decryption runs again and succeeds.
    expect(unwrapRight(retried).actions).toEqual(template.actions)
    expect(decrypt).toHaveBeenCalledTimes(2)
  })
})
