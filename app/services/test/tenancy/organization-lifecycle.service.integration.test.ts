import {OperatorRecoveryService} from "@services/tenancy/operator-recovery.service"
import {LIFECYCLE_REPOSITORY_TOKEN, LifecycleRepository} from "@services/tenancy/interfaces"
import {
  PLATFORM_SECURITY_EVENT_REPOSITORY_TOKEN,
  PlatformSecurityEventRepository
} from "@services/platform-security/interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import * as E from "fp-ts/Either"
import {AUDIT_LOG_REPOSITORY_TOKEN, AuditLogRepository} from "@services/audit-log/interfaces"
import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  dropPreparedDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {unwrapRight} from "@utils/either"
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import {UserWithToken} from "@test/types"
import {v7 as uuidv7} from "uuid"

describe("Organization lifecycle service integration", () => {
  let isolatedDb: string
  let redisPrefix: string
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let owner: UserWithToken

  beforeAll(async () => {
    isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()
    const module = await Test.createTestingModule({imports: [AppModule]})
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb, redisPrefix))
      .compile()

    app = module.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(isolatedDb)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)
    await app.init()
  }, 30000)

  beforeEach(async () => {
    owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(isolatedDb)
    await cleanRedisByPrefix(redisPrefix)
  })

  const operatorRecovery = () =>
    new OperatorRecoveryService(
      app.get<LifecycleRepository>(LIFECYCLE_REPOSITORY_TOKEN),
      app.get<AuditLogRepository>(AUDIT_LOG_REPOSITORY_TOKEN),
      app.get<PlatformSecurityEventRepository>(PLATFORM_SECURITY_EVENT_REPOSITORY_TOKEN),
      app.get<TenantTransactionManager>(TRANSACTION_MANAGER_TOKEN)
    )

  it("allows an operator to apply a system suspension to an owner-suspended organization", async () => {
    // Given
    const context = {organizationId: owner.user.organizationId}
    await prisma.organization.update({
      where: {id: context.organizationId},
      data: {status: "suspended", suspensionReason: "owner_requested"}
    })
    const before = await prisma.organization.findUniqueOrThrow({where: {id: context.organizationId}})
    const operator = {type: "operator" as const, id: uuidv7(), displayName: "Recovery operator"}

    // When
    const result = await operatorRecovery().setLifecycle(operator, context, {action: "suspend", reason: "security"})()

    // Expect
    expect(unwrapRight(result).status).toBe("suspended")
    expect(await prisma.organization.findUniqueOrThrow({where: {id: context.organizationId}})).toMatchObject({
      status: "suspended",
      suspensionReason: "security",
      occ: before.occ + 1n
    })
    expect(
      await prisma.auditLog.count({
        where: {organizationId: context.organizationId, auditType: "ORGANIZATION_SUSPENDED"}
      })
    ).toBe(1)
    expect(
      await prisma.platformSecurityEvent.count({where: {actorId: operator.id, eventType: "organization.suspended"}})
    ).toBe(1)
  })

  it("rejects an operator grace change for an active organization", async () => {
    // Given: operator recovery is outside the customer HTTP module.
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})

    // When
    const result = await operatorRecovery().setLifecycle(
      {type: "operator", id: uuidv7(), displayName: "Recovery operator"},
      {organizationId: owner.user.organizationId},
      {action: "set_grace", dueAt: new Date(Date.now() + 60_000), reason: "Recovery window"}
    )()

    // Expect
    expect(result).toEqual(E.left("organization_invalid_transition"))
    expect(await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})).toEqual(before)
    expect(await prisma.auditLog.count({where: {auditType: "ORGANIZATION_UPDATED"}})).toBe(0)
  })

  it("sets and clears an operator grace deadline while preserving the suspension", async () => {
    // Given
    await prisma.organization.update({
      where: {id: owner.user.organizationId},
      data: {
        status: "suspended",
        suspensionReason: "operator"
      }
    })
    const before = await prisma.organization.findUniqueOrThrow({where: {id: owner.user.organizationId}})
    const service = operatorRecovery()
    const operator = {type: "operator" as const, id: uuidv7(), displayName: "Recovery operator"}
    const context = {organizationId: owner.user.organizationId}
    const dueAt = new Date(Date.now() + 60_000)

    // When
    const set = await service.setLifecycle(operator, context, {action: "set_grace", dueAt, reason: "Recovery window"})()
    const afterSet = await prisma.organization.findUniqueOrThrow({where: {id: context.organizationId}})
    const cleared = await service.setLifecycle(operator, context, {action: "set_grace", reason: "Window removed"})()

    // Expect
    expect(unwrapRight(set).status).toBe("suspended")
    expect(afterSet.graceUntil).toEqual(dueAt)
    expect(unwrapRight(cleared).status).toBe("suspended")
    expect(await prisma.organization.findUniqueOrThrow({where: {id: context.organizationId}})).toMatchObject({
      graceUntil: null,
      suspensionReason: "operator",
      occ: before.occ + 2n
    })
    expect(await prisma.auditLog.count({where: {auditType: "ORGANIZATION_UPDATED"}})).toBe(2)
    const securityEvents = await prisma.platformSecurityEvent.findMany({
      where: {actorId: operator.id, eventType: "organization.grace_period_changed"},
      orderBy: {id: "asc"}
    })
    // The service writes through the dedicated platform security capability; read back the
    // persisted attribution and metadata to cover the repository mapping with real operator actions.
    expect(securityEvents).toEqual([
      expect.objectContaining({
        eventType: "organization.grace_period_changed",
        actorType: "operator",
        actorId: operator.id,
        reason: "Recovery window",
        metadata: {organizationId: context.organizationId, dueAt: dueAt.toISOString()}
      }),
      expect.objectContaining({
        eventType: "organization.grace_period_changed",
        actorType: "operator",
        actorId: operator.id,
        reason: "Window removed",
        metadata: {organizationId: context.organizationId}
      })
    ])
  })
})
