import {KMS_PROVIDER_TOKEN} from "@external/kms/kms.provider.interface"
import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {WorkflowFactory} from "@domain"
import {DATABASE_RUNTIME_ROLE_TOKEN, DatabaseClient} from "@external/database/database-client"
import {WorkflowTenantClient} from "@external/database/tenant-database-clients"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {WorkflowDbRepository} from "@external/database/workflow.repository"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {EnvVarKmsProvider} from "@external/kms/env-var-kms.provider"
import {PrismaClient, WorkflowTemplate} from "@prisma/client"
import {cleanDatabase, createFixturePrismaClient, prepareDatabase} from "@test/database"
import {createMockWorkflowTemplateInDb} from "@test/mock-data"
import {randomOrgId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"

describe("WorkflowDbRepository Integration", () => {
  let prisma: PrismaClient
  let module: TestingModule
  let repository: WorkflowDbRepository
  let transactions: PrismaTransactionManager
  let template: WorkflowTemplate
  let context: {organizationId: ReturnType<typeof randomOrgId>}

  beforeEach(async () => {
    const connectionString = await prepareDatabase()
    module = await Test.createTestingModule({
      providers: [
        DatabaseClient,
        WorkflowTenantClient,
        WorkflowDbRepository,
        PrismaTransactionManager,
        TenantEncryptionService,
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_tenant_runtime"},
        {
          provide: ConfigProvider,
          useValue: {
            databaseConfig: {
              tenantConnectionUrl: connectionString,
              platformConnectionUrl: connectionString,
              retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
            }
          }
        },
        {provide: KMS_PROVIDER_TOKEN, useValue: new EnvVarKmsProvider(new Map([[1, Buffer.alloc(32, 1)]]), 1)}
      ]
    }).compile()
    repository = module.get(WorkflowDbRepository)
    transactions = module.get(PrismaTransactionManager)
    await module.init()
    prisma = createFixturePrismaClient(connectionString)
    context = {organizationId: randomOrgId()}
    template = await createMockWorkflowTemplateInDb(prisma, context)
  }, 30_000)

  afterEach(async () => {
    jest.restoreAllMocks()
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await module.close()
  })

  async function createWorkflow() {
    const workflow = unwrapRight(
      WorkflowFactory.newWorkflow({
        organizationId: context.organizationId,
        workflowTemplateId: template.id,
        name: "Workflow",
        expiresAt: new Date(Date.now() + 60_000)
      })
    )
    return unwrapRight(await transactions.execute(context, () => repository.createWorkflow({workflow}))())
  }

  it("rejects foreign tenant reads and writes without changing the workflow", async () => {
    // Given
    const workflow = await createWorkflow()
    const before = await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})
    const foreignContext = {organizationId: randomOrgId()}
    await createMockWorkflowTemplateInDb(prisma, foreignContext)
    const foreignWorkflow = unwrapRight(
      WorkflowFactory.newWorkflow({...workflow, organizationId: foreignContext.organizationId, name: "Foreign"})
    )

    // When
    const read = await transactions.execute(foreignContext, () =>
      repository.getWorkflowById(foreignContext, workflow.id)
    )()
    const write = await transactions.execute(foreignContext, () =>
      repository.updateWorkflowConcurrentSafe(foreignContext, workflow.id, before.occ, {
        recalculationRequired: true,
        updatedAt: new Date()
      })
    )()
    const create = await transactions.execute(context, () => repository.createWorkflow({workflow: foreignWorkflow}))()
    const after = await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})
    const foreignCount = await prisma.workflow.count({where: {id: foreignWorkflow.id}})

    // Expect
    expect(read).toBeLeftOf("workflow_not_found")
    expect(write).toBeLeftOf("concurrency_error")
    expect(create).toBeLeft()
    expect(foreignCount).toBe(0)
    expect(after).toEqual(before)
  })
})
