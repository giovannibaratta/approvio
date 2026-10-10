import {pipe} from "fp-ts/function"
import {OrganizationFactory} from "@domain"
import {DriverAdapterError} from "@prisma/driver-adapter-utils"
import {randomOrgId} from "@test/organization-id"
import {DatabaseClient, TenantContextRequiredError} from "@external/database/database-client"
import {
  DiscoveryDatabaseClient,
  IdentityDatabaseClient,
  SchedulerDatabaseClient,
  SessionDatabaseClient
} from "@external/database/capability-database-client"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {LifecycleDbRepository} from "@external/database/lifecycle.repository"
import {GroupTenantClient, LifecycleTenantClient} from "@external/database/tenant-database-clients"
import {createFixturePrismaClient, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {seedTwoOrganizationFixture, TwoOrganizationFixture} from "@test/tenancy"
import {transactionContext} from "@external/database/transaction-context"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {Prisma, PrismaClient} from "@prisma/client"
import {v7 as uuidv7} from "uuid"

describe("tenant database boundary", () => {
  let isolatedDb: string
  let dbClient: DatabaseClient
  let fixturePrisma: PrismaClient
  let transactionManager: PrismaTransactionManager
  let fixture: TwoOrganizationFixture
  let config: {
    readonly databaseConfig: {
      readonly tenantConnectionUrl: string
      readonly platformConnectionUrl: string
      readonly poolSize: number
      readonly retry: {
        readonly maxAttempts: number
        readonly initialDelayMs: number
        readonly backoffFactor: number
        readonly maxDelayMs: number
      }
    }
  }

  beforeAll(async () => {
    isolatedDb = await prepareDatabase()
    config = {
      databaseConfig: {
        tenantConnectionUrl: isolatedDb,
        platformConnectionUrl: isolatedDb,
        poolSize: 2,
        retry: {maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    }
    dbClient = new DatabaseClient(config)
    fixturePrisma = createFixturePrismaClient(isolatedDb)
    transactionManager = new PrismaTransactionManager(dbClient)
    await dbClient.onModuleInit()
    fixture = await seedTwoOrganizationFixture(fixturePrisma)
  }, 30000)

  afterAll(async () => {
    await dbClient.onModuleDestroy()
    await fixturePrisma.$disconnect()
    await dropPreparedDatabase(isolatedDb)
  }, 30000)

  it("clears a grace deadline through the domain and guarded persistence", async () => {
    // Given
    const context = {organizationId: randomOrgId()}
    const repository = new LifecycleDbRepository(new LifecycleTenantClient(dbClient))
    const before = await fixturePrisma.organization.create({
      data: {
        id: context.organizationId,
        slug: `grace-${context.organizationId}`,
        displayName: "Grace test",
        planTier: "FREE",
        status: "suspended",
        suspensionReason: "operator",
        graceUntil: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        occ: 0n
      }
    })

    // When
    const result = await transactionManager.execute(context, () =>
      pipe(
        repository.get(context),
        TE.chainEitherKW(organization => OrganizationFactory.setGracePeriod(organization)),
        TE.chainW(organization => repository.persistTransition(context, before.occ, organization))
      )
    )()

    // Expect
    expect(E.isRight(result)).toBe(true)
    const updated = await fixturePrisma.organization.findUniqueOrThrow({where: {id: context.organizationId}})
    expect(updated.graceUntil).toBeNull()
    expect(updated.occ).toBe(before.occ + 1n)
    await fixturePrisma.organization.delete({where: {id: context.organizationId}})
  })

  it("rolls back a lifecycle transition when a subsequent update uses its stale version", async () => {
    // Given
    const context = {organizationId: fixture.organizationA.id}
    const repository = new LifecycleDbRepository(new LifecycleTenantClient(dbClient))
    const before = await fixturePrisma.organization.findUniqueOrThrow({where: {id: context.organizationId}})

    // When
    const result = await transactionManager.execute(context, () => async () => {
      const organization = await repository.get(context)()
      if (E.isLeft(organization)) return organization
      const suspended = OrganizationFactory.transition(
        organization.right,
        {status: "suspended", reason: "owner_requested"},
        "owner"
      )
      if (E.isLeft(suspended)) return suspended
      const persisted = await repository.persistTransition(context, organization.right.occ, suspended.right)()
      if (E.isLeft(persisted)) return persisted
      const resumed = OrganizationFactory.transition(suspended.right, {status: "active"}, "owner")
      if (E.isLeft(resumed)) return resumed
      return repository.persistTransition(context, organization.right.occ, resumed.right)()
    })()

    // Expect
    expect(result).toEqual(E.left("concurrent_modification_error"))
    expect(await fixturePrisma.organization.findUniqueOrThrow({where: {id: context.organizationId}})).toMatchObject({
      status: before.status,
      occ: before.occ,
      suspensionReason: before.suspensionReason
    })
  })

  it("rejects organization creation outside the transaction organization", async () => {
    // Given
    const organizationId = randomOrgId()
    const otherOrganizationId = randomOrgId()
    const now = new Date()

    // When
    const creation = dbClient.transactional(organizationId, tx =>
      tx.organization.createMany({
        data: [
          {
            id: otherOrganizationId,
            slug: `mismatched-${otherOrganizationId}`,
            displayName: "Mismatched organization",
            planTier: "FREE",
            status: "active",
            occ: 0n,
            createdAt: now,
            updatedAt: now
          }
        ]
      })
    )

    // Expect
    await expect(creation).rejects.toThrow(/row-level security/)
    expect(await fixturePrisma.organization.count({where: {id: otherOrganizationId}})).toBe(0)
  })

  it("fails before a tenant query when no transaction context exists", () => {
    expect(() => new GroupTenantClient(dbClient).cx).toThrow(TenantContextRequiredError)
  })

  it("isolates concurrent organizations and clears context after commit", async () => {
    const [groupsA, groupsB] = await Promise.all([
      dbClient.transactional(fixture.organizationA.id, tx => tx.group.findMany()),
      dbClient.transactional(fixture.organizationB.id, tx => tx.group.findMany())
    ])

    expect(groupsA).toHaveLength(1)
    expect(groupsB).toHaveLength(1)
    expect(groupsA[0]?.organizationId).toBe(fixture.organizationA.id)
    expect(groupsB[0]?.organizationId).toBe(fixture.organizationB.id)
    expect(() => new GroupTenantClient(dbClient).cx).toThrow(TenantContextRequiredError)
  })

  it("rolls back a business Left without retrying it", async () => {
    const groupId = uuidv7()
    let attempts = 0

    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, () => async () => {
      attempts++
      const now = new Date()
      await new GroupTenantClient(dbClient).cx.group.create({
        data: {
          id: groupId,
          organizationId: fixture.organizationA.id,
          name: `rollback-${groupId}`,
          description: null,
          createdAt: now,
          updatedAt: now,
          occ: 0n
        }
      })
      return E.left("business_rejected" as const)
    })()

    expect(result).toEqual(E.left("business_rejected"))
    expect(attempts).toBe(1)
    expect(await fixturePrisma.group.findUnique({where: {id: groupId}})).toBeNull()
    expect(() => new GroupTenantClient(dbClient).cx).toThrow(TenantContextRequiredError)
  })

  it("returns semantic OCC conflicts without retrying and restores context", async () => {
    let attempts = 0
    const observedOrganizations: string[] = []
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, () => async () => {
      attempts++
      const [setting] = await dbClient.transactional(
        fixture.organizationA.id,
        tx =>
          tx.$queryRaw<Array<{organizationId: string}>>`
          SELECT current_setting('approvio.organization_id') AS "organizationId"
        `
      )
      if (setting) observedOrganizations.push(setting.organizationId)
      return E.left("concurrency_error" as const)
    })()

    expect(result).toEqual(E.left("concurrency_error"))
    expect(attempts).toBe(1)
    expect(observedOrganizations).toEqual([fixture.organizationA.id])
  })

  it("returns retry_exhausted after confirmed serialization retries", async () => {
    let attempts = 0
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, () => () => {
      attempts++
      return Promise.reject(
        new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict", {
          code: "P2034",
          clientVersion: "7.9.1"
        })
      )
    })()

    expect(result).toEqual(E.left("retry_exhausted"))
    expect(attempts).toBe(3)
  })

  it("retries direct adapter serialization failures and reports exhaustion", async () => {
    let attempts = 0
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, () => () => {
      attempts++
      return Promise.reject(
        new DriverAdapterError({
          kind: "TransactionWriteConflict",
          originalCode: "40001",
          originalMessage: "could not serialize access"
        })
      )
    })()

    expect(result).toEqual(E.left("retry_exhausted"))
    expect(attempts).toBe(3)
  })

  it("does not retry an arbitrary P2028 transaction error", async () => {
    let attempts = 0
    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, () =>
      TE.tryCatch(
        () => {
          attempts++
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError("Transaction API error", {
              code: "P2028",
              clientVersion: "7.9.1"
            })
          )
        },
        error => {
          throw error
        }
      )
    )()

    expect(result).toEqual(E.left("storage_unavailable"))
    expect(attempts).toBe(1)
  })

  it("shares a same-organization nested transaction", async () => {
    let outerClient: Prisma.TransactionClient | undefined
    let innerClient: Prisma.TransactionClient | undefined

    const result = await transactionManager.execute({organizationId: fixture.organizationA.id}, () => {
      outerClient = transactionContext.getStore()?.tx
      return transactionManager.execute({organizationId: fixture.organizationA.id}, () => {
        innerClient = transactionContext.getStore()?.tx
        return TE.right("nested")
      })
    })()

    expect(result).toEqual(E.right("nested"))
    expect(innerClient).toBe(outerClient)
  })

  it("rejects nested cross-organization and stronger-isolation requests", async () => {
    const crossOrganization = await transactionManager.execute({organizationId: fixture.organizationA.id}, () =>
      transactionManager.execute({organizationId: fixture.organizationB.id}, () => TE.right(undefined))
    )()
    expect(crossOrganization).toEqual(E.left("organization_mismatch"))

    const strongerIsolation = await transactionManager.execute(
      {organizationId: fixture.organizationA.id},
      () =>
        transactionManager.execute({organizationId: fixture.organizationA.id}, () => TE.right(undefined), {
          isolationLevel: "Serializable"
        }),
      {isolationLevel: "RepeatableRead"}
    )()
    expect(strongerIsolation).toEqual(E.left("conflicting_isolation_level"))
  })

  describe("platform capability clients", () => {
    let identity: IdentityDatabaseClient
    let session: SessionDatabaseClient
    let discovery: DiscoveryDatabaseClient
    let scheduler: SchedulerDatabaseClient

    beforeAll(async () => {
      identity = new IdentityDatabaseClient(config)
      session = new SessionDatabaseClient(config)
      discovery = new DiscoveryDatabaseClient(config)
      scheduler = new SchedulerDatabaseClient(config)
      await Promise.all([
        identity.onModuleInit(),
        session.onModuleInit(),
        discovery.onModuleInit(),
        scheduler.onModuleInit()
      ])
    })

    afterAll(async () => {
      await Promise.all([
        identity.onModuleDestroy(),
        session.onModuleDestroy(),
        discovery.onModuleDestroy(),
        scheduler.onModuleDestroy()
      ])
    })

    it("limits identity, session and scheduler clients to their granted tables", async () => {
      expect(await identity.transactional(tx => tx.platformAccount.count())).toBe(2)
      await expect(
        identity.transactional(tx => {
          // @ts-expect-error Identity transactions do not expose tenant delegates.
          return tx.user.count()
        })
      ).rejects.toBeDefined()

      expect(await session.transactional(tx => tx.browserSession.count())).toBe(0)
      await expect(
        session.transactional(tx => {
          // @ts-expect-error Session transactions do not expose tenant delegates.
          return tx.user.count()
        })
      ).rejects.toBeDefined()

      expect(await scheduler.transactional(tx => tx.organization.count())).toBe(2)
      await expect(
        scheduler.transactional(tx => {
          // @ts-expect-error Scheduler transactions do not expose tenant delegates.
          return tx.user.count()
        })
      ).rejects.toBeDefined()
    })

    it("provisions atomically and exposes active membership keys to discovery", async () => {
      const organizationId = randomOrgId()
      const userId = uuidv7()

      await dbClient.transactional(organizationId, async tx => {
        const slug = `provisioned-${organizationId.slice(-8)}`
        const now = new Date()
        await tx.organization.createMany({
          data: [
            {
              id: organizationId,
              slug,
              displayName: "Provisioned",
              planTier: "FREE",
              status: "active",
              suspensionReason: null,
              graceUntil: null,
              occ: 1n,
              createdAt: now,
              updatedAt: now
            }
          ]
        })
        await tx.user.createMany({
          data: [
            {
              id: userId,
              organizationId,
              platformAccountId: fixture.accountId,
              displayName: "Provisioned Owner",
              status: "active",
              orgRole: "owner",
              roles: Prisma.JsonNull,
              occ: 1n,
              createdAt: now,
              updatedAt: now
            }
          ]
        })
      })

      const visibleOrganizationIds = await discovery.transactional(async tx =>
        (
          await tx.user.findMany({
            where: {platformAccountId: fixture.accountId, status: "active"},
            select: {organizationId: true},
            orderBy: {organizationId: "asc"}
          })
        ).map(item => item.organizationId)
      )
      expect(visibleOrganizationIds).toContain(organizationId)
      await expect(discovery.transactional(tx => tx.user.findMany({select: {displayName: true}}))).rejects.toBeDefined()
    })
  })
})
