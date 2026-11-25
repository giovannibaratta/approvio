import {Test, TestingModule} from "@nestjs/testing"
import {DatabaseClient} from "@external/database/database-client"
import {WORKER_DATABASE_CORE_TOKEN} from "@external/database/worker-database-core.token"
import {WorkerDatabaseClient} from "@external/database/capability-database-client"
import {WorkerOutboxDbRepository} from "@external/database/worker-outbox.repository"
import {PrismaWorkerTransactionManager} from "@external/database/worker-transaction-manager"
import {OutboxClaimFactory} from "@services/durable-work/models"
import {outboxRecoveryCriteria} from "@services/durable-work/tenant-outbox.utils"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {createMockOrganization} from "@test/mock-data"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

// Same-snapshot OCC conflicts need direct access to the persistence compare-and-set operation.
describe("WorkerOutboxDbRepository claim concurrency", () => {
  let module: TestingModule
  let connectionString: string
  let prisma: PrismaClient
  let workerTransactions: PrismaWorkerTransactionManager
  let workerRepository: WorkerOutboxDbRepository
  let organizationId: ReturnType<typeof toOrganizationId>

  beforeEach(async () => {
    connectionString = await prepareDatabase()
    const workerUrl = new URL(connectionString)
    workerUrl.username = "approvio_worker"
    module = await Test.createTestingModule({
      providers: [
        WorkerDatabaseClient,
        WorkerOutboxDbRepository,
        PrismaWorkerTransactionManager,
        {
          provide: WORKER_DATABASE_CORE_TOKEN,
          useFactory: () =>
            new DatabaseClient(
              {
                databaseConfig: {
                  tenantConnectionUrl: workerUrl.toString(),
                  platformConnectionUrl: connectionString,
                  retry: {maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
                }
              },
              "approvio_worker_runtime"
            )
        }
      ]
    }).compile()
    prisma = createFixturePrismaClient(connectionString)
    workerTransactions = module.get(PrismaWorkerTransactionManager)
    workerRepository = module.get(WorkerOutboxDbRepository)
    organizationId = randomOrgId()
    await prisma.organization.create({data: createMockOrganization({id: organizationId})})
    await module.init()
  }, 30000)

  afterEach(async () => {
    await module.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connectionString)
  })

  it("allows only one claim at the same candidate OCC", async () => {
    // Given
    await appendEvent()
    const context = {organizationId}
    const criteria = outboxRecoveryCriteria(uuidv7(), new Date(), 10)
    const [candidate] = unwrapRight(
      await workerTransactions.execute(context, () => workerRepository.listClaimCandidates(context, criteria))()
    )
    if (!candidate) throw new Error("Outbox fixture omitted its candidate")
    const claims = [uuidv7(), uuidv7()].map(owner =>
      unwrapRight(
        OutboxClaimFactory.validate({
          event: candidate.event,
          lease: {owner, fencing: candidate.fencing + 1n, expiresAt: criteria.leaseUntil}
        })
      )
    )

    // When
    const results = await Promise.all(
      claims.map(claim =>
        workerTransactions.execute(context, () => workerRepository.tryClaim(context, claim, candidate.occ))()
      )
    )

    // Expect
    expect(results.map(unwrapRight).sort()).toEqual([false, true])
    expect(await prisma.tenantOutbox.findFirstOrThrow()).toMatchObject({occ: 1n, attempts: 1n})
  })

  async function appendEvent() {
    const eventId = uuidv7()
    const workflowId = uuidv7()
    const createdAt = new Date(Date.now() - 11 * 60_000)
    await prisma.tenantOutbox.create({
      data: {
        id: uuidv7(),
        organizationId,
        eventId,
        eventType: "workflow.recalculate",
        schemaVersion: 1,
        resourceId: workflowId,
        payload: {organizationId, eventId, workflowId, type: "workflow.recalculate", schemaVersion: 1},
        createdAt,
        availableAt: createdAt,
        attempts: 0n,
        occ: 0n
      }
    })
  }
})
