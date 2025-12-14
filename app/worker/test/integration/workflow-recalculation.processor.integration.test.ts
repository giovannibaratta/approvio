import {WorkflowRecalculationProcessor} from "../../src/processor/workflow-recalculation.processor"
import {TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {MockConfigProvider, createMockWorkflowInDb} from "@test/mock-data"
import {cleanDatabase, prepareDatabase, prepareRedisPrefix, cleanRedisByPrefix} from "@test/database"
import {DatabaseClient} from "@external"
import {PrismaClient} from "@prisma/client"
import {Job} from "bull"
import {RecalculationJobData} from "@external/queue/queue.provider"
import {WorkflowStatus} from "@domain"
import {setupWorkerTestModule} from "./test-helpers"

describe("WorkflowRecalculationProcessor Integration", () => {
  let processor: WorkflowRecalculationProcessor
  let prisma: PrismaClient
  let redisPrefix: string
  let module: TestingModule

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    try {
      const moduleBuilder = setupWorkerTestModule([WorkflowRecalculationProcessor])
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb, redisPrefix))

      module = await moduleBuilder.compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    processor = module.get<WorkflowRecalculationProcessor>(WorkflowRecalculationProcessor)
    prisma = module.get(DatabaseClient)

    // Initialize the module to ensure all providers are ready
    await module.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await cleanRedisByPrefix(redisPrefix)
    await module.close()
  })

  it("should be defined", () => {
    expect(processor).toBeDefined()
  })

  describe("process", () => {
    it("should successfully recalculate workflow status and update recalculationRequired to false", async () => {
      // Given: A workflow that requires recalculation
      const workflow = await createMockWorkflowInDb(prisma, {
        name: "Workflow-To-Recalculate",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS
      })

      // Manually set recalculationRequired to true (createMockWorkflowInDb sets it to false by default)
      await prisma.workflow.update({
        where: {id: workflow.id},
        data: {recalculationRequired: true}
      })

      const job = {
        data: {workflowId: workflow.id},
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "job-1"
      } as Job<RecalculationJobData>

      // When
      await processor.process(job)

      // Then
      const updatedWorkflow = await prisma.workflow.findUnique({
        where: {id: workflow.id}
      })

      expect(updatedWorkflow).toBeDefined()
      expect(updatedWorkflow?.recalculationRequired).toBe(false)
      // Status might remain the same if no votes, but the flag should be cleared
      expect(updatedWorkflow?.status).toBe(WorkflowStatus.EVALUATION_IN_PROGRESS)
    })

    it("should throw an error if workflow does not exist", async () => {
      // Given: A job with a non-existent workflow ID (but valid UUID format)
      const job = {
        data: {workflowId: "00000000-0000-0000-0000-000000000000"},
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "job-2"
      } as Job<RecalculationJobData>

      // When/Then: The processor should throw an error
      await expect(processor.process(job)).rejects.toThrow("Workflow recalculation failed")
    })

    it("should throw an error if workflow ID is not a valid UUID", async () => {
      // Given: A job with an invalid UUID format
      const job = {
        data: {workflowId: "non-existent-id"},
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "job-3"
      } as Job<RecalculationJobData>

      // When/Then: The processor should throw an error about invalid format
      await expect(processor.process(job)).rejects.toThrow("Invalid workflow ID format")
    })
  })
})
