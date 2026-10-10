import {PrismaWorkerTransactionManager} from "@external/database/worker-transaction-manager"
import {DispatchService} from "@services/durable-work/dispatch.service"
import {DispatchCompletionFactory} from "@services/durable-work/models"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {WebhookActionHttpMethod, WorkflowActionEmailTaskFactory, WorkflowActionWebhookTaskFactory} from "@domain"
import {DatabaseClient} from "@external/database/database-client"
import {DispatchDbRepository} from "@external/database/dispatch.repository"
import {PrismaTaskRepository} from "@external/database/task.repository"
import {WorkerDatabaseClient} from "@external/database/capability-database-client"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {EnvVarKmsProvider} from "@external/kms/env-var-kms.provider"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {generateDeterministicId} from "@utils/uuid"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("PrismaTaskRepository integration", () => {
  let prisma: PrismaClient
  let database: DatabaseClient
  let workers: WorkerDatabaseClient
  let tasks: PrismaTaskRepository
  let dispatch: DispatchService
  let organizationId: ReturnType<typeof toOrganizationId>
  let workflowId: string

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
    const encryption = new TenantEncryptionService(new EnvVarKmsProvider(new Map([[1, Buffer.alloc(32, 7)]]), 1))
    workers = new WorkerDatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connectionString,
        platformConnectionUrl: connectionString,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    tasks = new PrismaTaskRepository(workers, encryption)
    dispatch = new DispatchService(new DispatchDbRepository(workers), new PrismaWorkerTransactionManager(workers), {
      dispatchConfig: {concurrencyPerOrganization: 4, leaseDurationMs: 120_000}
    })
    organizationId = randomOrgId()
    workflowId = await createWorkflow(prisma, organizationId)
    await workers.onModuleInit()
  }, 30_000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await workers.onModuleDestroy()
    await database.onModuleDestroy()
  })

  it("checks a fixed dispatch lease without modifying it and rejects expired ownership", async () => {
    // Given: a committed task claimed by one delivery attempt.
    const context = {organizationId}
    const task = createEmailTask(organizationId, workflowId)
    unwrapRight(
      await database.transactional(organizationId, () =>
        tasks.createEmailTask(context, {
          task,
          metadata: {eventId: uuidv7(), actionIndex: 0, availableAt: new Date()}
        })()
      )
    )
    const claim = unwrapRight(await dispatch.claim(context, task.id, "email", uuidv7(), new Date())())
    const where = {organizationId_id: {organizationId, id: task.id}}
    // Shorten the persisted lease to reproduce a delivery approaching its expiry without waiting a minute.
    await prisma.durableWork.update({where, data: {leaseUntil: new Date(Date.now() + 10_000)}})

    // When
    const before = await prisma.durableWork.findUniqueOrThrow({where})
    const attemptBefore = await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})
    unwrapRight(await dispatch.validateAttemptLease(context, claim.attemptId, claim.lease)())
    unwrapRight(await dispatch.startExecution(context, claim.attemptId, claim.lease)())
    const sending = await prisma.durableWork.findUniqueOrThrow({where})
    unwrapRight(await dispatch.validateAttemptLease(context, claim.attemptId, claim.lease)())

    // Expect: checks preserve expiry and row version; sending changes only the dispatch state and OCC.
    expect(sending.leaseUntil).toEqual(before.leaseUntil)
    expect(sending).toMatchObject({
      state: "sending",
      occ: before.occ + 1n,
      attempts: before.attempts,
      fencing: before.fencing
    })
    const attemptAfter = await prisma.dispatchAttempt.findUniqueOrThrow({where: {id: claim.attemptId}})
    expect(attemptAfter).toMatchObject({
      state: "sending",
      occ: attemptBefore.occ + 1n,
      fencing: attemptBefore.fencing,
      admittedAt: attemptBefore.admittedAt,
      completedAt: null,
      outcomeCategory: null
    })
    expect(attemptAfter.sendingAt).toBeInstanceOf(Date)
    expect(await prisma.durableWork.findUniqueOrThrow({where})).toEqual(sending)
    expect(await prisma.dispatchAttempt.count({where: {organizationId, durableWorkId: task.id}})).toBe(1)

    // Given: storage ownership has changed; the old caller cannot authorize another owner's lease.
    const replacementOwner = uuidv7()
    await prisma.durableWork.update({where, data: {leaseOwner: replacementOwner, fencing: {increment: 1}}})
    // Expect
    expect(await dispatch.validateAttemptLease(context, claim.attemptId, claim.lease)()).toBeLeftOf("lease_lost")
    expect((await prisma.durableWork.findUniqueOrThrow({where})).leaseOwner).toBe(replacementOwner)

    // Given: storage says this owner has expired, even though the caller still holds its lease object.
    await prisma.durableWork.update({
      where,
      data: {leaseOwner: claim.lease.owner, fencing: claim.lease.fencing, leaseUntil: new Date(0)}
    })
    // Expect: checks must reject expired ownership.
    expect(await dispatch.validateAttemptLease(context, claim.attemptId, claim.lease)()).toBeLeftOf("lease_lost")
  })

  it("encrypts durable task payloads, rejects a foreign organization, and fences stale completion", async () => {
    const task = createEmailTask(organizationId, workflowId)
    const eventId = uuidv7()
    const context = {organizationId}
    const metadata = {
      eventId,
      actionIndex: 0,
      availableAt: new Date()
    }

    unwrapRight(await database.transactional(organizationId, () => tasks.createEmailTask(context, {task, metadata})()))

    const raw = await prisma.workflowActionsEmailTask.findUnique({
      where: {organizationId_id: {organizationId, id: task.id}}
    })
    expect(raw?.encPayload).toMatch(/^approvio:enc:v1:/)
    expect(raw?.encPayload).not.toContain("task-secret@example.test")
    expect(raw?.eventId).toBe(eventId)
    expect(raw?.state).toBe("ready")

    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: organization(otherOrganizationId)})
    const foreignRead = await database.transactional(otherOrganizationId, () =>
      tasks.getEmailTask({organizationId: otherOrganizationId}, task.id)()
    )
    expect(foreignRead).toBeLeftOf("task_not_found")

    const duplicate = createEmailTask(organizationId, workflowId)
    const duplicateResult = await database.transactional(organizationId, () =>
      tasks.createEmailTask(context, {task: duplicate, metadata})()
    )
    expect(duplicateResult).toBeLeftOf("task_already_exists")

    const abandoned = unwrapRight(await dispatch.claim(context, task.id, "email", uuidv7(), new Date())())
    unwrapRight(
      await dispatch.complete(
        context,
        abandoned.attemptId,
        abandoned.lease,
        unwrapRight(
          DispatchCompletionFactory.validate({
            state: "failed",
            outcome: {type: "task_load_failed", error: "task_not_found"}
          })
        ),
        uuidv7()
      )()
    )
    const retryableWork = await prisma.durableWork.findUnique({
      where: {organizationId_id: {organizationId, id: task.id}}
    })
    expect(retryableWork?.state).toBe("retry_due")

    const admitted = unwrapRight(await dispatch.claim(context, task.id, "email", uuidv7(), new Date())())
    expect(admitted.lease.fencing).toBeGreaterThan(abandoned.lease.fencing)
    unwrapRight(await dispatch.startExecution(context, admitted.attemptId, admitted.lease)())
    unwrapRight(
      await dispatch.complete(
        context,
        admitted.attemptId,
        admitted.lease,
        unwrapRight(
          DispatchCompletionFactory.validate({
            state: "retry_due",
            outcome: {type: "delivery_error", error: "http_timeout"}
          })
        ),
        uuidv7()
      )()
    )
    const reclaimed = unwrapRight(
      await dispatch.claim(context, task.id, "email", uuidv7(), new Date(Date.now() + 1_000))()
    )
    expect(reclaimed.lease.fencing).toBeGreaterThan(admitted.lease.fencing)
    unwrapRight(await dispatch.startExecution(context, reclaimed.attemptId, reclaimed.lease)())
    const stale = await dispatch.complete(
      context,
      abandoned.attemptId,
      abandoned.lease,
      unwrapRight(
        DispatchCompletionFactory.validate({
          state: "succeeded",
          outcome: {type: "delivered"}
        })
      ),
      uuidv7()
    )()
    expect(stale).toBeLeftOf("lease_lost")
    unwrapRight(
      await dispatch.complete(
        context,
        reclaimed.attemptId,
        reclaimed.lease,
        unwrapRight(DispatchCompletionFactory.validate({state: "succeeded", outcome: {type: "delivered"}})),
        uuidv7()
      )()
    )
  })

  it("reclaims an unknown webhook outcome with a new fencing token", async () => {
    const task = createWebhookTask(organizationId, workflowId)
    const context = {organizationId}
    const metadata = {eventId: uuidv7(), actionIndex: 0, availableAt: new Date()}
    unwrapRight(
      await database.transactional(organizationId, () => tasks.createWebhookTask(context, {task, metadata})())
    )

    const sending = unwrapRight(await dispatch.claim(context, task.id, "webhook", uuidv7(), new Date())())
    unwrapRight(await dispatch.startExecution(context, sending.attemptId, sending.lease)())
    unwrapRight(
      await dispatch.complete(
        context,
        sending.attemptId,
        sending.lease,
        unwrapRight(
          DispatchCompletionFactory.validate({
            state: "unknown",
            outcome: {type: "delivery_error", error: "http_timeout"}
          })
        ),
        uuidv7()
      )()
    )

    const retry = unwrapRight(
      await dispatch.claim(context, task.id, "webhook", uuidv7(), new Date(Date.now() + 1_000))()
    )
    expect(retry.lease.fencing).toBeGreaterThan(sending.lease.fencing)
  })
})

function createEmailTask(organizationId: string, workflowId: string) {
  return unwrapRight(
    WorkflowActionEmailTaskFactory.newWorkflowActionEmailTask({
      id: generateDeterministicId(`task-${workflowId}`),
      organizationId: toOrganizationId(organizationId),
      workflowId,
      recipients: ["task-secret@example.test"],
      subject: "Secret subject",
      body: "Secret body"
    })
  )
}

function createWebhookTask(organizationId: string, workflowId: string) {
  return unwrapRight(
    WorkflowActionWebhookTaskFactory.newWorkflowActionWebhookTask({
      id: generateDeterministicId(`webhook-task-${workflowId}`),
      organizationId: toOrganizationId(organizationId),
      workflowId,
      url: "https://example.test/hook",
      method: WebhookActionHttpMethod.POST,
      payload: {message: "test"}
    })
  )
}

async function createWorkflow(prisma: PrismaClient, organizationId: string): Promise<string> {
  await prisma.organization.create({data: organization(organizationId)})
  const spaceId = uuidv7()
  const templateId = uuidv7()
  const workflowId = uuidv7()
  const now = new Date()
  await prisma.space.create({
    data: {
      id: spaceId,
      organizationId,
      name: `space-${spaceId}`,
      description: null,
      createdAt: now,
      updatedAt: now,
      occ: 0n
    }
  })
  await prisma.workflowTemplate.create({
    data: {
      id: templateId,
      organizationId,
      name: `template-${templateId}`,
      description: null,
      approvalRule: {type: "GROUP_REQUIREMENT", groupId: uuidv7(), minCount: 1},
      encActions: null,
      defaultExpiresInHours: null,
      createdAt: now,
      updatedAt: now,
      status: "ACTIVE",
      version: 1,
      allowVotingOnDeprecatedTemplate: false,
      occ: 0n,
      spaceId
    }
  })
  await prisma.workflow.create({
    data: {
      id: workflowId,
      organizationId,
      name: `workflow-${workflowId}`,
      description: null,
      createdAt: now,
      updatedAt: now,
      status: "PENDING",
      occ: 0n,
      recalculationRequired: false,
      workflowTemplateId: templateId,
      expiresAt: new Date(now.getTime() + 60_000)
    }
  })
  return workflowId
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
