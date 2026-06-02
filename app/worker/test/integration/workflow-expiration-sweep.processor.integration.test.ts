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
import {cleanDatabase, prepareDatabase, prepareRedisPrefix, cleanRedisByPrefix} from "@test/database"
import {DatabaseClient, WORKFLOW_EXPIRATION_SWEEP_QUEUE, WORKFLOW_STATUS_RECALCULATION_QUEUE} from "@external"
import {PrismaClient} from "@prisma/client"
import {getQueueToken} from "@nestjs/bull"
import {Queue} from "bull"
import {setupWorkerTestModule} from "./test-helpers"

describe("WorkflowExpirationSweepProcessor Integration", () => {
  let processor: WorkflowExpirationSweepProcessor
  let prisma: PrismaClient
  let redisPrefix: string
  let module: TestingModule
  let sweepQueue: Queue
  let recalcQueue: Queue

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    try {
      const moduleBuilder = setupWorkerTestModule([WorkflowExpirationSweepProcessor])
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb, redisPrefix))

      module = await moduleBuilder.compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    processor = module.get<WorkflowExpirationSweepProcessor>(WorkflowExpirationSweepProcessor)
    prisma = module.get(DatabaseClient).prisma
    sweepQueue = module.get<Queue>(getQueueToken(WORKFLOW_EXPIRATION_SWEEP_QUEUE))
    recalcQueue = module.get<Queue>(getQueueToken(WORKFLOW_STATUS_RECALCULATION_QUEUE))

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
    await recalcQueue.empty()
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

      await createMockUserInDb(prisma, {orgAdmin: true})
      const space = await createMockSpaceInDb(prisma, {name: "Test Space"})
      const spaceId = space.id
      const template = await createMockWorkflowTemplateInDb(prisma, {
        name: "Test Template",
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
        workflowTemplateId: templateId,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        expiresAt: pastDate
      })
      const expiredWorkflowId = expiredWorkflow.id

      const futureWorkflow = await createMockWorkflowInDb(prisma, {
        name: "Future",
        workflowTemplateId: templateId,
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        expiresAt: futureDate
      })
      const futureWorkflowId = futureWorkflow.id

      const alreadyEnqueuedWorkflow = await createMockWorkflowInDb(prisma, {
        name: "Already Enqueued",
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
        workflowTemplateId: templateId,
        status: WorkflowStatus.APPROVED,
        expiresAt: pastDate
      })
      const terminalWorkflowId = terminalWorkflow.id

      // When: We run the processor sweep
      await processor.sweepExpired()

      // Then: Verify Database state
      const expiredWorkflowFromDb = await prisma.workflow.findUnique({where: {id: expiredWorkflowId}})
      expect(expiredWorkflowFromDb?.recalculationRequired).toBe(true)

      const futureWorkflowFromDb = await prisma.workflow.findUnique({where: {id: futureWorkflowId}})
      expect(futureWorkflowFromDb?.recalculationRequired).toBe(false)

      const alreadyEnqueuedWorkflowFromDb = await prisma.workflow.findUnique({where: {id: alreadyEnqueuedWorkflowId}})
      expect(alreadyEnqueuedWorkflowFromDb?.recalculationRequired).toBe(true) // still true

      const terminalWorkflowFromDb = await prisma.workflow.findUnique({where: {id: terminalWorkflowId}})
      expect(terminalWorkflowFromDb?.recalculationRequired).toBe(false)

      // Then: Verify Queue state (recalculation queue)
      const jobs = await recalcQueue.getJobs(["waiting", "active", "delayed"])
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.data.workflowId).toBe(expiredWorkflowId)
    })
  })
})
