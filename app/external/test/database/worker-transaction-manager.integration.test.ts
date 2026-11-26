import {EventReceiptService} from "@services/durable-work/event-receipt.service"
import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {WORKER_DATABASE_CORE_TOKEN} from "@external/database/worker-database-core.token"
import {EventReceiptDbRepository} from "@external/database/event-receipt.repository"
import {EventReceiptTenantClient, TenantOutboxTenantClient} from "@external/database/tenant-database-clients"
import {TenantOutboxDbRepository} from "@external/database/tenant-outbox.repository"
import {DATABASE_RUNTIME_ROLE_TOKEN, DatabaseClient} from "@external/database/database-client"
import {DispatchService} from "@services/durable-work/dispatch.service"
import {WorkerDatabaseClient} from "@external/database/capability-database-client"
import {PrismaWorkerTransactionManager} from "@external/database/worker-transaction-manager"
import {createFixturePrismaClient, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {seedTwoOrganizationFixture, TwoOrganizationFixture} from "@test/tenancy"
import {PrismaClient} from "@prisma/client"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {DispatchDbRepository} from "@external/database/dispatch.repository"
import {pipe} from "fp-ts/function"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("worker transaction boundary", () => {
  let connection: string
  let prisma: PrismaClient
  let module: TestingModule
  let workerDatabase: DatabaseClient
  let workers: WorkerDatabaseClient
  let manager: PrismaWorkerTransactionManager
  let fixture: TwoOrganizationFixture

  beforeAll(async () => {
    connection = await prepareDatabase()
    prisma = createFixturePrismaClient(connection)
    module = await Test.createTestingModule({
      providers: [
        DatabaseClient,
        WorkerDatabaseClient,
        PrismaWorkerTransactionManager,
        DispatchDbRepository,
        {provide: WORKER_DATABASE_CORE_TOKEN, useExisting: DatabaseClient},
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_worker_runtime"},
        {
          provide: ConfigProvider,
          useValue: {
            databaseConfig: {
              tenantConnectionUrl: connection,
              platformConnectionUrl: connection,
              retry: {maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
            }
          }
        }
      ]
    }).compile()
    workerDatabase = module.get(DatabaseClient)
    workers = module.get(WorkerDatabaseClient)
    manager = module.get(PrismaWorkerTransactionManager)
    await module.init()
    fixture = await seedTwoOrganizationFixture(prisma)
  }, 30000)

  afterAll(async () => {
    await module.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
  }, 30000)

  // Worker services can nest database calls inside a transaction started by the worker manager.
  // They must share that transaction so a later business failure rolls back every write.
  it("reuses nested worker adapters and rolls their writes back on a business Left", async () => {
    // Given
    const context = {organizationId: fixture.organizationA.id}
    const taskId = uuidv7()
    let computations = 0

    // When
    const result = await manager.execute(context, () => {
      computations++
      return pipe(
        TE.tryCatch(
          () =>
            workers.transactional(context.organizationId, async cx => {
              const now = new Date()
              await cx.durableWork.create({
                data: {
                  id: taskId,
                  organizationId: context.organizationId,
                  kind: "email",
                  state: "ready",
                  availableAt: now,
                  createdAt: now,
                  updatedAt: now,
                  occ: 0n,
                  fencing: 0n,
                  attempts: 0
                }
              })
              // The nested call can see the uncommitted row only if it shares the outer transaction.
              await workers.transactional(context.organizationId, async nested => {
                expect(await nested.durableWork.count({where: {id: taskId}})).toBe(1)
              })
            }),
          () => "query_failed" as const
        ),
        // Simulate a business failure after the nested database calls succeed.
        TE.chainW(() => TE.left("business_rejected" as const))
      )
    })()

    // Expect: the business error is returned without a retry, and the row is rolled back.
    expect(computations).toBe(1)
    expect(result).toBeLeftOf("business_rejected")
    expect(await prisma.durableWork.count({where: {id: taskId}})).toBe(0)
  })

  it("retries the entire worker transaction after a real serializable write collision", async () => {
    // Given: both transactions must read the original row before either writes it.
    const organizationId = fixture.organizationA.id
    const taskId = uuidv7()
    await prisma.durableWork.create({data: workRow(organizationId, taskId)})
    let releaseReads!: () => void
    const readsComplete = new Promise<void>(resolve => {
      releaseReads = resolve
    })
    let computations = 0
    let initialReads = 0
    const increment = () =>
      manager.execute(
        {organizationId},
        () => async () => {
          computations++
          const result = await workers.transactional(organizationId, async cx => {
            const row = await cx.durableWork.findUniqueOrThrow({
              where: {organizationId_id: {organizationId, id: taskId}}
            })
            if (computations <= 2) {
              initialReads++
              if (initialReads === 2) releaseReads()
              await readsComplete
            }
            return cx.durableWork.update({
              where: {organizationId_id: {organizationId, id: taskId}},
              data: {attempts: row.attempts + 1, occ: {increment: 1}}
            })
          })
          return E.right(result)
        },
        {isolationLevel: "Serializable"}
      )()

    // When: PostgreSQL rejects one write based on its stale Serializable snapshot.
    const results = await Promise.all([increment(), increment()])

    // Expect: the losing computation runs again using a fresh worker transaction.
    expect(results).toHaveLength(2)
    results.forEach(result => expect(result).toBeRight())
    expect(computations).toBe(3)
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toMatchObject({attempts: 2, occ: 2n})
  })

  it("preserves dispatch collisions for whole-transaction retry and rolls back losing side effects", async () => {
    // Given: both dispatches read the same ready task before claiming it.
    const organizationId = fixture.organizationA.id
    const taskId = uuidv7()
    await prisma.durableWork.create({data: workRow(organizationId, taskId)})
    const admission = new DispatchService(
      module.get(DispatchDbRepository),
      new PrismaWorkerTransactionManager(workers),
      {
        dispatchConfig: {concurrencyPerOrganization: 4, leaseDurationMs: 120_000}
      },
      new EventReceiptService(
        new EventReceiptDbRepository(new EventReceiptTenantClient(workerDatabase)),
        new PrismaWorkerTransactionManager(workers)
      ),
      new TenantOutboxDbRepository(new TenantOutboxTenantClient(workerDatabase))
    )
    let releaseReads!: () => void
    const readsComplete = new Promise<void>(resolve => {
      releaseReads = resolve
    })
    let computations = 0
    let initialReads = 0
    const sideEffectIds = [uuidv7(), uuidv7()]
    const claim = (sideEffectId: string) =>
      manager.execute(
        {organizationId},
        () => async () => {
          computations++
          await workers.transactional(organizationId, async cx => {
            await cx.durableWork.findUniqueOrThrow({where: {organizationId_id: {organizationId, id: taskId}}})
            if (computations <= 2) {
              initialReads++
              if (initialReads === 2) releaseReads()
              await readsComplete
            }
            await cx.durableWork.create({data: workRow(organizationId, sideEffectId)})
          })
          return admission.claim({organizationId}, taskId, "email", uuidv7(), new Date())()
        },
        {isolationLevel: "Serializable"}
      )()

    // When: a nested repository encounters a real conflict rather than a mocked response.
    const results = await Promise.all(sideEffectIds.map(claim))

    // Expect: one lease wins; the retried loser sees claimed work and rolls back its other write.
    expect(results.filter(E.isRight)).toHaveLength(1)
    expect(results.filter(E.isLeft).map(result => result.left)).toEqual(["dispatch_invalid_source_state"])
    expect(computations).toBe(3)
    expect(await prisma.dispatchAttempt.count({where: {organizationId, taskId}})).toBe(1)
    expect(await prisma.durableWork.count({where: {organizationId, id: {in: sideEffectIds}}})).toBe(1)
    expect(await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).toMatchObject({
      state: "claimed",
      attempts: 1,
      fencing: 1n
    })
  })

  it("serializes capacity admission across different task rows", async () => {
    // Given: two workers establish snapshots with no active work in an organization capped at one.
    const organizationId = fixture.organizationB.id
    const taskIds = [uuidv7(), uuidv7()]
    await prisma.durableWork.createMany({data: taskIds.map(id => workRow(organizationId, id))})
    const admission = new DispatchService(
      module.get(DispatchDbRepository),
      new PrismaWorkerTransactionManager(workers),
      {
        dispatchConfig: {concurrencyPerOrganization: 1, leaseDurationMs: 120_000}
      },
      new EventReceiptService(
        new EventReceiptDbRepository(new EventReceiptTenantClient(workerDatabase)),
        new PrismaWorkerTransactionManager(workers)
      ),
      new TenantOutboxDbRepository(new TenantOutboxTenantClient(workerDatabase))
    )
    let releaseReads = () => {}
    const readsComplete = new Promise<void>(resolve => {
      releaseReads = resolve
    })
    let initialReads = 0
    let computations = 0
    const claim = (taskId: string) =>
      manager.execute(
        {organizationId},
        () => async () => {
          computations++
          await workers.transactional(organizationId, async cx => {
            await cx.durableWork.count({where: {organizationId, state: {in: ["claimed", "sending"]}}})
            if (initialReads < 2) {
              initialReads++
              if (initialReads === 2) releaseReads()
              await readsComplete
            }
          })
          return admission.claim({organizationId}, taskId, "email", uuidv7(), new Date())()
        },
        {isolationLevel: "Serializable"}
      )()
    // When: both attempt admission for different tasks using those snapshots.
    const results = await Promise.all(taskIds.map(claim))
    // Expect: the retried loser observes the live lease and cannot create a second attempt.
    expect(results.filter(E.isRight)).toHaveLength(1)
    expect(results.filter(E.isLeft).map(result => result.left)).toEqual(["capacity_exceeded"])
    expect(computations).toBe(3)
    expect(await prisma.dispatchAttempt.count({where: {organizationId}})).toBe(1)
    expect(await prisma.durableWork.count({where: {organizationId, state: "claimed"}})).toBe(1)
  })

  it("reports retry exhaustion after a real collision when the attempt budget is one", async () => {
    // Given
    const organizationId = fixture.organizationA.id
    const taskId = uuidv7()
    await prisma.durableWork.create({data: workRow(organizationId, taskId)})
    const singleAttemptDatabase = new DatabaseClient(
      {
        databaseConfig: {
          tenantConnectionUrl: connection,
          platformConnectionUrl: connection,
          retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
        }
      },
      "approvio_worker_runtime"
    )
    const singleAttemptWorkers = new WorkerDatabaseClient(singleAttemptDatabase)
    const singleAttemptManager = new PrismaWorkerTransactionManager(singleAttemptWorkers)
    await singleAttemptDatabase.onModuleInit()
    let releaseReads!: () => void
    const readsComplete = new Promise<void>(resolve => {
      releaseReads = resolve
    })
    let initialReads = 0
    const increment = () =>
      singleAttemptManager.execute(
        {organizationId},
        () => async () => {
          const row = await singleAttemptWorkers.transactional(organizationId, async cx => {
            const current = await cx.durableWork.findUniqueOrThrow({
              where: {organizationId_id: {organizationId, id: taskId}}
            })
            initialReads++
            if (initialReads === 2) releaseReads()
            await readsComplete
            return cx.durableWork.update({
              where: {organizationId_id: {organizationId, id: taskId}},
              data: {attempts: current.attempts + 1}
            })
          })
          return E.right(row)
        },
        {isolationLevel: "Serializable"}
      )()
    try {
      // When
      const results = await Promise.all([increment(), increment()])
      // Expect
      expect(results.filter(E.isRight)).toHaveLength(1)
      expect(results.filter(E.isLeft).map(result => result.left)).toEqual(["retry_exhausted"])
      expect((await prisma.durableWork.findUniqueOrThrow({where: {id: taskId}})).attempts).toBe(1)
    } finally {
      await singleAttemptDatabase.onModuleDestroy()
    }
  })
})

function workRow(organizationId: string, id: string) {
  const now = new Date()
  return {
    id,
    organizationId,
    kind: "email",
    state: "ready",
    availableAt: now,
    createdAt: now,
    updatedAt: now,
    occ: 0n,
    fencing: 0n,
    attempts: 0
  }
}
