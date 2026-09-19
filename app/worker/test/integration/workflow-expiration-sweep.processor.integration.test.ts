import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {WorkflowExpirationSweepProcessor} from "../../src/processor/workflow-expiration-sweep.processor"
import {TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {
  MockConfigProvider,
  createMockUserInDb,
  createMockWorkflowTemplateInDb,
  createMockSpaceInDb,
  createMockWorkflowInDb
} from "@test/mock-data"
import {WorkflowStatus} from "@domain"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {WORKFLOW_EXPIRATION_SWEEP_QUEUE} from "@external"
import {PrismaClient} from "@prisma/client"
import {getQueueToken} from "@nestjs/bull"
import {Queue} from "bull"
import {setupWorkerTestModule} from "./test-helpers"
import {WorkflowRecalculationService} from "@services/workflow/workflow-recalculation.service"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"

describe("WorkflowExpirationSweepProcessor Integration", () => {
  let processor: WorkflowExpirationSweepProcessor
  let prisma: PrismaClient
  let redisPrefix: string
  let module: TestingModule
  let sweepQueue: Queue

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    try {
      const moduleBuilder = setupWorkerTestModule([WorkflowExpirationSweepProcessor])
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb, redisPrefix))

      module = await moduleBuilder.compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    processor = module.get<WorkflowExpirationSweepProcessor>(WorkflowExpirationSweepProcessor)
    prisma = createFixturePrismaClient(isolatedDb)
    sweepQueue = module.get<Queue>(getQueueToken(WORKFLOW_EXPIRATION_SWEEP_QUEUE))

    // Initialize the module to ensure all providers are ready
    await module.init()
  }, 30000)

  afterAll(async () => {
    await prisma.$disconnect()
    await module.close()
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
    await cleanRedisByPrefix(redisPrefix)
    await sweepQueue.empty()
  })

  it("should be defined", () => {
    expect(processor).toBeDefined()
  })

  describe("sweepExpired", () => {
    it("should successfully run the sweep and acquire/release lock", async () => {
      // Clear queue and any lock from redis
      const lockKey = "lock:sweep-expired-workflows"
      await sweepQueue.client.del(lockKey)

      // When: We run the sweep
      await expect(processor.sweepExpired()).resolves.not.toThrow()

      // Then: The lock should have been released
      const lockValue = await sweepQueue.client.get(lockKey)
      expect(lockValue).toBeNull()
    })

    it("should skip execution if another sweep job holds the lock", async () => {
      const lockKey = "lock:sweep-expired-workflows"
      // Pre-acquire the lock
      await sweepQueue.client.set(lockKey, "pre-locked", "PX", 60000)

      // When: We run the sweep, it should log skip and exit without throwing
      await expect(processor.sweepExpired()).resolves.not.toThrow()

      // Then: The lock should still be held by the other process
      const lockValue = await sweepQueue.client.get(lockKey)
      expect(lockValue).toBe("pre-locked")

      // Clean up
      await sweepQueue.client.del(lockKey)
    })

    it("should sweep expired workflows, update database status, and enqueue recalculation tasks", async () => {
      const now = new Date()
      const pastDate = new Date(now.getTime() - 1000 * 60 * 60) // 1 hour ago
      const futureDate = new Date(now.getTime() + 1000 * 60 * 60) // 1 hour in the future

      // Seed database with workflows

      const commonDate = new Date()
      const organizationId = randomOrgId()

      await createMockUserInDb(prisma, {orgAdmin: true, organizationId})
      const space = await createMockSpaceInDb(prisma, {name: "Test Space", organizationId})
      const spaceId = space.id
      const template = await createMockWorkflowTemplateInDb(prisma, {
        name: "Test Template",
        organizationId,
        spaceId,
        status: "DRAFT",
        version: 1,
        createdAt: commonDate,
        updatedAt: commonDate,
        approvalRule: {},
        actions: []
      })
      const templateId = template.id

      // Create Workflows
      const expiredWorkflow = await createMockWorkflowInDb(prisma, {
        name: "Expired",
        organizationId,
        workflowTemplateId: templateId,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        expiresAt: pastDate
      })
      const expiredWorkflowId = expiredWorkflow.id

      const futureWorkflow = await createMockWorkflowInDb(prisma, {
        name: "Future",
        organizationId,
        workflowTemplateId: templateId,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        expiresAt: futureDate
      })
      const futureWorkflowId = futureWorkflow.id

      const alreadyEnqueuedWorkflow = await createMockWorkflowInDb(prisma, {
        name: "Already Enqueued",
        organizationId,
        workflowTemplateId: templateId,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        expiresAt: pastDate
      })
      await prisma.workflow.update({
        where: {id: alreadyEnqueuedWorkflow.id},
        data: {recalculationRequired: true}
      })
      const alreadyEnqueuedWorkflowId = alreadyEnqueuedWorkflow.id

      const terminalWorkflow = await createMockWorkflowInDb(prisma, {
        name: "Terminal",
        organizationId,
        workflowTemplateId: templateId,
        status: WorkflowStatus.APPROVED,
        expiresAt: pastDate
      })
      const terminalWorkflowId = terminalWorkflow.id

      await prisma.workflowExpirationSchedule.create({
        data: {organizationId, nextSweepAt: pastDate}
      })

      // When: We run the processor sweep
      await processor.sweepExpired()

      const scheduledJobs = await sweepQueue.getJobs(["waiting", "active", "completed"])
      const organizationJob = scheduledJobs.find(
        queuedJob => queuedJob.name === "sweep-organization" && queuedJob.data.organizationId === organizationId
      )
      if (!organizationJob) throw new Error("Expected the scheduler to enqueue the due organization")
      await organizationJob.finished()

      // Then: Verify Database state
      const expiredWorkflowFromDb = await prisma.workflow.findUnique({where: {id: expiredWorkflowId}})
      expect(expiredWorkflowFromDb?.recalculationRequired).toBe(true)

      const futureWorkflowFromDb = await prisma.workflow.findUnique({where: {id: futureWorkflowId}})
      expect(futureWorkflowFromDb?.recalculationRequired).toBe(false)

      const alreadyEnqueuedWorkflowFromDb = await prisma.workflow.findUnique({where: {id: alreadyEnqueuedWorkflowId}})
      expect(alreadyEnqueuedWorkflowFromDb?.recalculationRequired).toBe(true) // still true

      const terminalWorkflowFromDb = await prisma.workflow.findUnique({where: {id: terminalWorkflowId}})
      expect(terminalWorkflowFromDb?.recalculationRequired).toBe(false)

      const events = await prisma.tenantOutbox.findMany({
        where: {organizationId: expiredWorkflow.organizationId, eventType: "workflow.recalculate"}
      })
      expect(events).toHaveLength(1)
      expect(events.at(0)?.payload).toMatchObject({workflowId: expiredWorkflowId, type: "workflow.recalculate"})
    })

    it("advances through expired workflows in bounded stable batches", async () => {
      // Given: Two expired workflows and a due organization schedule, with a batch size of one.
      const organizationId = randomOrgId()
      await createMockUserInDb(prisma, {orgAdmin: true, organizationId})
      const space = await createMockSpaceInDb(prisma, {name: "Batched Expiration Space", organizationId})
      const template = await createMockWorkflowTemplateInDb(prisma, {
        name: "Batched Expiration Template",
        organizationId,
        spaceId: space.id,
        actions: []
      })
      const now = new Date()
      const olderWorkflow = await createMockWorkflowInDb(prisma, {
        name: "Older Expired Workflow",
        organizationId,
        workflowTemplateId: template.id,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        expiresAt: new Date(now.getTime() - 2000)
      })
      const newerWorkflow = await createMockWorkflowInDb(prisma, {
        name: "Newer Expired Workflow",
        organizationId,
        workflowTemplateId: template.id,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        expiresAt: new Date(now.getTime() - 1000)
      })
      await prisma.workflowExpirationSchedule.create({
        data: {organizationId, nextSweepAt: olderWorkflow.expiresAt}
      })
      const recalculation = module.get(WorkflowRecalculationService)
      const context = {organizationId: toOrganizationId(template.organizationId)}

      // When: Process the first batch.
      const firstBatchResult = await recalculation.scheduleExpiredWorkflowRecalculations(context, now, 1)()

      // Expect: Only the older workflow is marked, and the schedule advances to the newer expiration.
      expect(unwrapRight(firstBatchResult)).toBe(1)
      const olderAfterFirstBatch = await prisma.workflow.findUniqueOrThrow({where: {id: olderWorkflow.id}})
      const newerAfterFirstBatch = await prisma.workflow.findUniqueOrThrow({where: {id: newerWorkflow.id}})
      expect(olderAfterFirstBatch.recalculationRequired).toBe(true)
      expect(newerAfterFirstBatch.recalculationRequired).toBe(false)
      const nextScheduleAfterFirstBatch = await prisma.workflowExpirationSchedule.findUniqueOrThrow({
        where: {organizationId}
      })
      expect(nextScheduleAfterFirstBatch.nextSweepAt).toEqual(newerWorkflow.expiresAt)

      // When: Process the next batch.
      const secondBatchResult = await recalculation.scheduleExpiredWorkflowRecalculations(context, now, 1)()

      // Expect: The newer workflow is now marked for recalculation.
      expect(unwrapRight(secondBatchResult)).toBe(1)
      const newerAfterSecondBatch = await prisma.workflow.findUniqueOrThrow({where: {id: newerWorkflow.id}})
      expect(newerAfterSecondBatch.recalculationRequired).toBe(true)

      // When: Sweep again after both expired workflows have been marked.
      const emptyBatchResult = await recalculation.scheduleExpiredWorkflowRecalculations(context, now, 1)()

      // Expect: No further work is scheduled, and each workflow has exactly one recalculation event.
      expect(unwrapRight(emptyBatchResult)).toBe(0)
      const finalSchedule = await prisma.workflowExpirationSchedule.findUniqueOrThrow({where: {organizationId}})
      expect(finalSchedule.nextSweepAt).toBeNull()

      const events = await prisma.tenantOutbox.findMany({
        where: {organizationId: template.organizationId, eventType: "workflow.recalculate"}
      })
      expect(events).toHaveLength(2)
      expect(events.map(event => event.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({workflowId: olderWorkflow.id}),
          expect.objectContaining({workflowId: newerWorkflow.id})
        ])
      )
    })
  })
})
