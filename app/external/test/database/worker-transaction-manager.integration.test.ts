import {DispatchService} from "@services/durable-work/dispatch.service"
import {WorkerDatabaseClient} from "@external/database/capability-database-client"
import {PrismaWorkerTransactionManager} from "@external/database/worker-transaction-manager"
import {createFixturePrismaClient, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {seedTwoOrganizationFixture, TwoOrganizationFixture} from "@test/tenancy"
import {Prisma, PrismaClient} from "@prisma/client"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {DispatchDbRepository} from "@external/database/dispatch.repository"
import {pipe} from "fp-ts/function"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("worker transaction boundary", () => {
  let connection: string
  let prisma: PrismaClient
  let workers: WorkerDatabaseClient
  let manager: PrismaWorkerTransactionManager
  let fixture: TwoOrganizationFixture

  beforeAll(async () => {
    connection = await prepareDatabase()
    prisma = createFixturePrismaClient(connection)
    workers = new WorkerDatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connection,
        platformConnectionUrl: connection,
        retry: {maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    manager = new PrismaWorkerTransactionManager(workers)
    await workers.onModuleInit()
    fixture = await seedTwoOrganizationFixture(prisma)
  }, 30000)

  afterAll(async () => {
    await workers.onModuleDestroy()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
  }, 30000)

  it("reuses nested worker adapters and rolls their writes back on a business Left", async () => {
    const context = {organizationId: fixture.organizationA.id}
    const taskId = uuidv7()
    let computations = 0
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
              await workers.transactional(context.organizationId, async nested => {
                expect(nested).toBe(cx)
                expect(await nested.durableWork.count({where: {id: taskId}})).toBe(1)
              })
            }),
          () => "query_failed" as const
        ),
        TE.chainW(() => TE.left("business_rejected" as const))
      )
    })()

    expect(computations).toBe(1)
    expect(result).toBeLeftOf("business_rejected")
    expect(await prisma.durableWork.count({where: {id: taskId}})).toBe(0)
  })

  it("rejects cross-organization nesting before invoking the nested computation", async () => {
    const nested = jest.fn(() => TE.right(undefined))
    const result = await manager.execute({organizationId: fixture.organizationA.id}, () =>
      manager.execute({organizationId: fixture.organizationB.id}, nested)
    )()

    expect(result).toBeLeftOf("organization_mismatch")
    expect(nested).not.toHaveBeenCalled()
  })

  it("rejects a stronger nested isolation level", async () => {
    const nested = jest.fn(() => TE.right(undefined))
    const result = await manager.execute({organizationId: fixture.organizationA.id}, () =>
      manager.execute({organizationId: fixture.organizationA.id}, nested, {isolationLevel: "Serializable"})
    )()

    expect(result).toBeLeftOf("conflicting_isolation_level")
    expect(nested).not.toHaveBeenCalled()
  })

  it("keeps concurrent organization transactions separate and clears context after commit", async () => {
    const organizations = [fixture.organizationA.id, fixture.organizationB.id]
    const results = await Promise.all(
      organizations.map(organizationId =>
        manager.execute({organizationId}, () =>
          TE.tryCatch(
            () =>
              workers.transactional(organizationId, async cx => {
                const now = new Date()
                return cx.durableWork.create({
                  data: {
                    id: uuidv7(),
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
                })
              }),
            () => "query_failed" as const
          )
        )()
      )
    )

    expect(results[0]).toBeRightOf(expect.objectContaining({organizationId: organizations[0]}))
    expect(results[1]).toBeRightOf(expect.objectContaining({organizationId: organizations[1]}))
    await workers.transactional(
      fixture.organizationB.id,
      async cx => {
        const rows = await cx.durableWork.findMany()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.organizationId).toBe(fixture.organizationB.id)
      },
      {isolationLevel: Prisma.TransactionIsolationLevel.Serializable}
    )
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
      new DispatchDbRepository(workers),
      new PrismaWorkerTransactionManager(workers),
      {
        dispatchConfig: {concurrencyPerOrganization: 4, leaseDurationMs: 120_000}
      }
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

    // Expect: one lease wins; the retried loser sees the current lease and rolls back its other write.
    expect(results.filter(E.isRight)).toHaveLength(1)
    expect(results.filter(E.isLeft).map(result => result.left)).toEqual(["lease_lost"])
    expect(computations).toBe(3)
    expect(await prisma.dispatchAttempt.count({where: {organizationId, durableWorkId: taskId}})).toBe(1)
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
      new DispatchDbRepository(workers),
      new PrismaWorkerTransactionManager(workers),
      {
        dispatchConfig: {concurrencyPerOrganization: 1, leaseDurationMs: 120_000}
      }
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
    const singleAttemptWorkers = new WorkerDatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connection,
        platformConnectionUrl: connection,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    const singleAttemptManager = new PrismaWorkerTransactionManager(singleAttemptWorkers)
    await singleAttemptWorkers.onModuleInit()
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
      await singleAttemptWorkers.onModuleDestroy()
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
