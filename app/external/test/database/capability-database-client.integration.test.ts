import {Test, TestingModule} from "@nestjs/testing"
import {WORKER_DATABASE_CORE_TOKEN} from "@external/database/worker-database-core.token"
import {DatabaseClient, GlobalScopeRequiredError, TenantContextRequiredError} from "@external/database/database-client"
import {WorkerDatabaseClient} from "@external/database/capability-database-client"
import {WorkerOrganizationStatusDbRepository} from "@external/database/worker-organization-status.repository"
import {GroupTenantClient} from "@external/database/tenant-database-clients"
import {transactionContext} from "@external/database/transaction-context"
import {fromPromise} from "@external/database/repository-operation"
import {Prisma, PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {seedTwoOrganizationFixture, TwoOrganizationFixture} from "@test/tenancy"
import * as E from "fp-ts/Either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("shared capability database client", () => {
  let module: TestingModule
  let connection: string
  let prisma: PrismaClient
  let tenant: DatabaseClient
  let otherTenant: DatabaseClient
  let identity: DatabaseClient
  let scheduler: DatabaseClient
  let worker: DatabaseClient
  let workers: WorkerDatabaseClient
  let fixture: TwoOrganizationFixture

  beforeAll(async () => {
    connection = await prepareDatabase()
    prisma = createFixturePrismaClient(connection)

    const config = {
      databaseConfig: {
        tenantConnectionUrl: connection,
        platformConnectionUrl: connection,
        retry: {maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    }

    // Invalid alternate URLs verify that each role selects the correct connection family.
    const unavailable = "postgresql://test:test@localhost:1/unavailable"
    module = await Test.createTestingModule({
      providers: [
        {provide: DatabaseClient, useFactory: () => new DatabaseClient(config, "approvio_tenant_runtime")},
        {provide: "otherTenant", useFactory: () => new DatabaseClient(config, "approvio_tenant_runtime")},
        {provide: WORKER_DATABASE_CORE_TOKEN, useFactory: () => new DatabaseClient(config, "approvio_worker_runtime")},
        {
          provide: "identity",
          useFactory: () =>
            new DatabaseClient(
              {databaseConfig: {...config.databaseConfig, tenantConnectionUrl: unavailable}},
              "approvio_identity_runtime"
            )
        },
        {
          provide: "scheduler",
          useFactory: () =>
            new DatabaseClient(
              {databaseConfig: {...config.databaseConfig, platformConnectionUrl: unavailable}},
              "approvio_scheduler_runtime"
            )
        },
        WorkerDatabaseClient,
        GroupTenantClient,
        WorkerOrganizationStatusDbRepository
      ]
    }).compile()
    tenant = module.get(DatabaseClient)
    otherTenant = module.get("otherTenant")
    worker = module.get(WORKER_DATABASE_CORE_TOKEN)
    workers = module.get(WorkerDatabaseClient)
    identity = module.get("identity")
    scheduler = module.get("scheduler")
    await module.init()
    fixture = await seedTwoOrganizationFixture(prisma)
  }, 30_000)

  afterAll(async () => {
    await module.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
  }, 30_000)

  async function outboxEvent() {
    const organizationId = fixture.organizationA.id
    const eventId = uuidv7()
    const workflowId = uuidv7()
    return prisma.tenantOutbox.create({
      data: {
        id: uuidv7(),
        organizationId,
        eventId,
        eventType: "workflow.recalculate",
        schemaVersion: 1,
        resourceId: workflowId,
        payload: {organizationId, eventId, workflowId, type: "workflow.recalculate", schemaVersion: 1},
        createdAt: new Date(),
        availableAt: new Date(),
        attempts: 0n,
        occ: 0n
      }
    })
  }

  it("denies tenant writes to outbox worker lease columns", async () => {
    // Given
    const before = await outboxEvent()

    // When
    const result = tenant.transactional({type: "organization", organizationId: before.organizationId}, tx =>
      tx.tenantOutbox.updateMany({where: {id: before.id}, data: {leaseOwner: uuidv7()}})
    )

    // Expect: This bypasses repositories to verify the database capability itself.
    await expect(result).rejects.toMatchObject({meta: {driverAdapterError: {cause: {kind: "postgres", code: "42501"}}}})
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: before.id}})).toEqual(before)
  })

  it("denies tenant rewrites of an outbox payload", async () => {
    // Given
    const before = await outboxEvent()

    // When
    const result = tenant.transactional({type: "organization", organizationId: before.organizationId}, tx =>
      tx.tenantOutbox.updateMany({where: {id: before.id}, data: {payload: {changed: true}}})
    )

    // Expect
    await expect(result).rejects.toMatchObject({meta: {driverAdapterError: {cause: {kind: "postgres", code: "42501"}}}})
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: before.id}})).toEqual(before)
  })

  it("excludes foreign outbox rows from tenant publication updates", async () => {
    // Given
    const before = await outboxEvent()

    // When
    const result = await tenant.transactional({type: "organization", organizationId: fixture.organizationB.id}, tx =>
      tx.tenantOutbox.updateMany({where: {id: before.id}, data: {publishedAt: new Date()}})
    )

    // Expect: RLS hides the row even when the caller omits an organization filter.
    expect(result.count).toBe(0)
    expect(await prisma.tenantOutbox.findUniqueOrThrow({where: {id: before.id}})).toEqual(before)
  })

  it("blocks changing immutable receipt fields during consumption through the transaction's Prisma extension", async () => {
    // Given
    const args: Prisma.StepUpReceiptUpdateArgs = {
      where: {id: uuidv7(), consumedAt: null},
      data: {consumedAt: new Date(), operation: "vote"}
    }

    // When
    const result = tenant.transactional({type: "organization", organizationId: fixture.organizationA.id}, tx =>
      tx.stepUpReceipt.update(args)
    )

    // Expect
    await expect(result).rejects.toThrow(
      "Step-up receipt mutation is forbidden. Only a single-record update setting consumedAt to a valid date, with a consumedAt: null condition and no other field changes, is allowed."
    )
  })

  it("blocks resetting receipt consumption through the transaction's Prisma extension", async () => {
    // Given
    const args: Prisma.StepUpReceiptUpdateArgs = {where: {id: uuidv7(), consumedAt: null}, data: {consumedAt: null}}

    // When
    const result = tenant.transactional({type: "organization", organizationId: fixture.organizationA.id}, tx =>
      tx.stepUpReceipt.update(args)
    )

    // Expect
    await expect(result).rejects.toThrow(
      "Step-up receipt mutation is forbidden. Only a single-record update setting consumedAt to a valid date, with a consumedAt: null condition and no other field changes, is allowed."
    )
  })

  it("blocks overwriting receipt consumption without a null guard through the transaction's Prisma extension", async () => {
    // Given
    const args: Prisma.StepUpReceiptUpdateArgs = {where: {id: uuidv7()}, data: {consumedAt: new Date()}}

    // When
    const result = tenant.transactional({type: "organization", organizationId: fixture.organizationA.id}, tx =>
      tx.stepUpReceipt.update(args)
    )

    // Expect
    await expect(result).rejects.toThrow(
      "Step-up receipt mutation is forbidden. Only a single-record update setting consumedAt to a valid date, with a consumedAt: null condition and no other field changes, is allowed."
    )
  })

  it("blocks receipt updateMany through the transaction's Prisma extension", async () => {
    // Given
    const args: Prisma.StepUpReceiptUpdateManyArgs = {data: {consumedAt: new Date()}}

    // When
    const result = tenant.transactional({type: "organization", organizationId: fixture.organizationA.id}, tx =>
      tx.stepUpReceipt.updateMany(args)
    )

    // Expect
    await expect(result).rejects.toThrow(
      "Step-up receipt mutation is forbidden. Only a single-record update setting consumedAt to a valid date, with a consumedAt: null condition and no other field changes, is allowed."
    )
  })

  it("blocks receipt updateManyAndReturn through the transaction's Prisma extension", async () => {
    // Given
    const args: Prisma.StepUpReceiptUpdateManyAndReturnArgs = {data: {consumedAt: new Date()}}

    // When
    const result = tenant.transactional({type: "organization", organizationId: fixture.organizationA.id}, tx =>
      tx.stepUpReceipt.updateManyAndReturn(args)
    )

    // Expect
    await expect(result).rejects.toThrow(
      "Step-up receipt mutation is forbidden. Only a single-record update setting consumedAt to a valid date, with a consumedAt: null condition and no other field changes, is allowed."
    )
  })

  it("blocks receipt upsert through the transaction's Prisma extension", async () => {
    // Given
    const args: Prisma.StepUpReceiptUpsertArgs = {
      where: {id: uuidv7()},
      create: {
        id: uuidv7(),
        organizationId: fixture.organizationA.id,
        jti: uuidv7(),
        userId: fixture.organizationA.userId,
        sessionId: uuidv7(),
        providerId: "custom",
        contextVersion: 0n,
        operation: "vote",
        resourceId: uuidv7(),
        expiresAt: new Date(),
        createdAt: new Date()
      },
      update: {consumedAt: null}
    }

    // When
    const result = tenant.transactional({type: "organization", organizationId: fixture.organizationA.id}, tx =>
      tx.stepUpReceipt.upsert(args)
    )

    // Expect
    await expect(result).rejects.toThrow(
      "Step-up receipt mutation is forbidden. Only a single-record update setting consumedAt to a valid date, with a consumedAt: null condition and no other field changes, is allowed."
    )
  })

  it("blocks receipt delete through the transaction's Prisma extension", async () => {
    // Given
    const args: Prisma.StepUpReceiptDeleteArgs = {where: {id: uuidv7()}}

    // When
    const result = tenant.transactional({type: "organization", organizationId: fixture.organizationA.id}, tx =>
      tx.stepUpReceipt.delete(args)
    )

    // Expect
    await expect(result).rejects.toThrow(
      "Step-up receipt mutation is forbidden. Only a single-record update setting consumedAt to a valid date, with a consumedAt: null condition and no other field changes, is allowed."
    )
  })

  it("blocks receipt deleteMany through the transaction's Prisma extension", async () => {
    // Given
    const args: Prisma.StepUpReceiptDeleteManyArgs = {}

    // When
    const result = tenant.transactional({type: "organization", organizationId: fixture.organizationA.id}, tx =>
      tx.stepUpReceipt.deleteMany(args)
    )

    // Expect
    await expect(result).rejects.toThrow(
      "Step-up receipt mutation is forbidden. Only a single-record update setting consumedAt to a valid date, with a consumedAt: null condition and no other field changes, is allowed."
    )
  })

  it("rejects global scope for tenant clients and organization scope for identity clients", () => {
    // Given
    const computation = jest.fn(() => Promise.resolve(undefined))

    // When / Expect
    expect(() => tenant.transactional({type: "global"}, computation)).toThrow(TenantContextRequiredError)
    expect(() =>
      identity.transactional({type: "organization", organizationId: fixture.organizationA.id}, computation)
    ).toThrow(GlobalScopeRequiredError)
    expect(computation).not.toHaveBeenCalled()
  })

  it("runs identity transactions with the identity role and no organization context", async () => {
    // When
    const [session] = await identity.transactional(
      {type: "global"},
      tx =>
        tx.$queryRaw<Array<{role: string; organizationId: string | null}>>`
        SELECT current_user AS role, current_setting('approvio.organization_id', true) AS "organizationId"
      `
    )
    const organizations = await scheduler.transactional({type: "global"}, tx => tx.organization.findMany())

    // Expect
    expect(session).toEqual({role: "approvio_identity_runtime", organizationId: null})
    expect(organizations.map(organization => organization.id).sort()).toEqual(
      [fixture.organizationA.id, fixture.organizationB.id].sort()
    )
    expect(transactionContext.getStore()).toBeUndefined()
  })

  it("reuses a global transaction and rolls back a returned business Left", async () => {
    // Given
    const id = uuidv7()
    const now = new Date()

    // When
    const result = await identity.transactional({type: "global"}, async tx => {
      await tx.platformAccount.create({
        data: {
          id,
          displayName: "Rollback",
          profileEmail: `${id}@example.com`,
          status: "active",
          createdAt: now,
          updatedAt: now,
          occ: 0n
        }
      })
      await identity.transactional({type: "global"}, async nested => {
        expect(nested).toBe(tx)
        expect(await nested.platformAccount.count({where: {id}})).toBe(1)
      })
      return E.left("business_rejected" as const)
    })

    // Expect
    expect(result).toBeLeftOf("business_rejected")
    expect(await prisma.platformAccount.findUnique({where: {id}})).toBeNull()
    expect(transactionContext.getStore()).toBeUndefined()
  })

  it("retries a whole global transaction after a mapped conflict", async () => {
    // Given
    const id = uuidv7()
    const now = new Date()
    let attempts = 0

    // When
    const result = await identity.transactional({type: "global"}, tx =>
      fromPromise(
        async () => {
          attempts++
          await tx.platformAccount.create({
            data: {
              id,
              displayName: "Retry",
              profileEmail: `${id}@example.com`,
              status: "active",
              createdAt: now,
              updatedAt: now,
              occ: 0n
            }
          })
          if (attempts === 1)
            throw new Prisma.PrismaClientKnownRequestError("write conflict", {code: "P2034", clientVersion: "7.9.1"})
        },
        () => "repository_dependency_error" as const
      )()
    )

    // Expect
    expect(result).toBeRight()
    expect(attempts).toBe(2)
    expect(await prisma.platformAccount.count({where: {id}})).toBe(1)
  })

  it("keeps transactions from separate clients isolated even when their roles match", async () => {
    // Given
    const organizationId = fixture.organizationA.id
    const id = uuidv7()
    const now = new Date()

    // When
    const result = await tenant.transactional({type: "organization", organizationId}, async outer => {
      await otherTenant.transactional({type: "organization", organizationId}, async inner => {
        expect(inner).not.toBe(outer)
        expect(() => module.get(GroupTenantClient).cx).toThrow(TenantContextRequiredError)
        await inner.group.create({
          data: {id, organizationId, name: `Independent ${id}`, createdAt: now, updatedAt: now, occ: 0n}
        })
      })
      expect(transactionContext.getStore()?.client).toBe(tenant)
      return E.left("outer_rejected" as const)
    })

    // Expect
    expect(result).toBeLeftOf("outer_rejected")
    expect(await prisma.group.findUnique({where: {id}})).not.toBeNull()
  })

  it("restores the organization context after an independent global transaction", async () => {
    // Given
    const organizationId = fixture.organizationA.id
    const groups = module.get(GroupTenantClient)

    // When
    await tenant.transactional({type: "organization", organizationId}, async tx => {
      await identity.transactional({type: "global"}, async global => {
        expect(() => groups.cx).toThrow(TenantContextRequiredError)
        expect(await global.platformAccount.count()).toBeGreaterThan(0)
      })

      // Expect
      expect(groups.cx.group).toBe(tx.group)
      expect(transactionContext.getStore()?.client).toBe(tenant)
    })
    expect(transactionContext.getStore()).toBeUndefined()
  })

  it("shares the injected worker core transaction with worker repositories", async () => {
    // Given
    const organizationId = fixture.organizationA.id

    // When
    await worker.transactional({type: "organization", organizationId}, async tx => {
      await workers.transactional(organizationId, async cx => {
        expect(cx.durableWork).toBe(tx.durableWork)
        expect(transactionContext.getStore()?.client).toBe(worker)
        expect(await module.get(WorkerOrganizationStatusDbRepository).getStatus({organizationId})()).toBeRightOf(
          "active"
        )
      })
    })
    // Expect
    expect(transactionContext.getStore()).toBeUndefined()
  })
})
