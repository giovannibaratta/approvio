import {PrismaWorkerTransactionManager} from "@external/database/worker-transaction-manager"
import {TenantOutboxService} from "@services/durable-work/tenant-outbox.service"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {UsageSettlementResultFactory} from "@services/durable-work/models"
import {UsageOperationFactory} from "@services/durable-work/models"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {DatabaseClient} from "@external/database/database-client"
import {WorkerDatabaseClient} from "@external/database/capability-database-client"
import {TenantOutboxDbRepository} from "@external/database/tenant-outbox.repository"
import {TenantOutboxTenantClient, UsageOperationTenantClient} from "@external/database/tenant-database-clients"
import {UsageOperationDbRepository} from "@external/database/usage-operation.repository"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("UsageOperationDbRepository integration", () => {
  let prisma: PrismaClient
  let database: DatabaseClient
  let workers: WorkerDatabaseClient
  let repository: UsageOperationDbRepository
  let outbox: TenantOutboxDbRepository
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
    workers = new WorkerDatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connectionString,
        platformConnectionUrl: connectionString,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    prisma = createFixturePrismaClient(connectionString)
    outbox = new TenantOutboxDbRepository(new TenantOutboxTenantClient(database), workers)
    repository = new UsageOperationDbRepository(new UsageOperationTenantClient(database))
    organizationId = randomOrgId()
    await prisma.organization.create({data: organization(organizationId)})
  }, 30_000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await workers.onModuleDestroy()
    await database.onModuleDestroy()
  })

  it("keeps operation idempotency, immutable facts and settlement intents tenant-qualified", async () => {
    const input = operation(organizationId)
    expect(unwrapRight(await database.transactional(organizationId, () => repository.reserve(input)()))).toBe("new")
    expect(unwrapRight(await database.transactional(organizationId, () => repository.reserve(input)()))).toBe(
      "duplicate"
    )

    const mismatch = await database.transactional(organizationId, () =>
      repository.reserve({...input, estimatedUnits: input.estimatedUnits + 1})()
    )
    expect(mismatch).toBeLeftOf("operation_mismatch")

    unwrapRight(
      await database.transactional(organizationId, () =>
        pipe(
          repository.completeOperation(
            input,
            unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 7}))
          ),
          TE.chainFirstW(event =>
            event === undefined
              ? TE.right(undefined)
              : new TenantOutboxService(outbox, new PrismaWorkerTransactionManager(workers)).append(
                  {organizationId},
                  event
                )
          )
        )()
      )
    )
    const intent = await prisma.usageSettlementIntent.findFirst({
      where: {organizationId, operationId: input.operationId}
    })
    expect(intent).toMatchObject({desiredStatus: "settled", actualUnits: 7n, appliedAt: null})
    expect(
      await prisma.tenantOutbox.findFirst({
        where: {organizationId, eventType: "usage.settlement", resourceId: input.operationId, resourceVersion: 1n}
      })
    ).not.toBeNull()
    unwrapRight(
      await database.transactional(organizationId, () =>
        repository.acknowledge({organizationId}, input.operationId, "1")()
      )
    )
    unwrapRight(
      await database.transactional(organizationId, () =>
        repository.acknowledge({organizationId}, input.operationId, "1")()
      )
    )

    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: organization(otherOrganizationId)})
    const pending = unwrapRight(
      await database.transactional(otherOrganizationId, () =>
        repository.getReservedOperations({organizationId: otherOrganizationId}, 10)()
      )
    )
    expect(pending).toEqual([])
  })
  it("preserves validation errors when persisted operation metadata is malformed", async () => {
    // Given
    const input = operation(organizationId)
    unwrapRight(await database.transactional(organizationId, () => repository.reserve(input)()))
    await prisma.usageOperation.updateMany({
      where: {organizationId, operationId: input.operationId},
      data: {actorDisplayName: " "}
    })
    // When
    const result = await database.transactional(organizationId, () =>
      repository.get({organizationId}, input.operationId)()
    )
    // Expect
    expect(result).toBeLeftOf("invalid_actor")
  })
})

function operation(organizationId: ReturnType<typeof toOrganizationId>) {
  return unwrapRight(
    UsageOperationFactory.validate({
      organizationId,
      operationId: uuidv7(),
      metric: "MAX_LLM_TOKENS_PER_MONTH" as const,
      period: "2026-09",
      entityType: "WORKFLOW",
      entityId: uuidv7(),
      actor: {type: "user" as const, id: uuidv7(), displayName: "meter"},
      estimatedUnits: 10,
      isBillable: true
    })
  )
}

function organization(id: string) {
  const now = new Date()
  return {
    id,
    slug: `test-${id}`,
    displayName: "Test organization",
    planTier: "FREE",
    status: "active",
    occ: 0n,
    createdAt: now,
    updatedAt: now
  }
}
