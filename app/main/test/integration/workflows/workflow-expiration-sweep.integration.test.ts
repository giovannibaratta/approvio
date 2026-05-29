import {INestApplication} from "@nestjs/common"
import {Test, TestingModule} from "@nestjs/testing"
import {AppModule} from "../../../src/app.module"
import {DatabaseClient, WORKFLOW_STATUS_RECALCULATION_QUEUE} from "@external"
import {WorkflowRecalculationService} from "@services"
import {cleanDatabase} from "@test/database"
import {generateDeterministicId} from "@utils"
import {getQueueToken} from "@nestjs/bull"
import {Queue} from "bull"

describe("Workflow Expiration Sweep Integration", () => {
  let app: INestApplication
  let dbClient: DatabaseClient
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any
  let recalcService: WorkflowRecalculationService
  let workflowQueue: Queue

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    }).compile()

    app = moduleFixture.createNestApplication({logger: false})
    await app.init()

    dbClient = app.get<DatabaseClient>(DatabaseClient)
    prisma = dbClient.cx
    recalcService = app.get<WorkflowRecalculationService>(WorkflowRecalculationService)
    workflowQueue = app.get<Queue>(getQueueToken(WORKFLOW_STATUS_RECALCULATION_QUEUE))
  })

  beforeEach(async () => {
    // Note: cleanDatabase expects a PrismaClient instance, but for these tests dbClient.cx works fine as an unknown cast
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cleanDatabase(prisma as unknown as any)
    // Clear the queue to ensure a clean state
    await workflowQueue.empty()
  })

  afterAll(async () => {
    await app.close()
  })

  it("should sweep expired workflows and enqueue recalculation tasks", async () => {
    const now = new Date()
    const pastDate = new Date(now.getTime() - 1000 * 60 * 60) // 1 hour ago
    const futureDate = new Date(now.getTime() + 1000 * 60 * 60) // 1 hour in the future

    // Seed database with workflows
    const orgAdminId = generateDeterministicId("org-admin")
    const spaceId = generateDeterministicId("space")
    const templateId = generateDeterministicId("template")

    // 1. Expired Workflow (should be enqueued and marked)
    const expiredWorkflowId = generateDeterministicId("expired-workflow")
    // 2. Future Workflow (should NOT be enqueued)
    const futureWorkflowId = generateDeterministicId("future-workflow")
    // 3. Expired but already enqueued Workflow (should NOT be enqueued again)
    const alreadyEnqueuedWorkflowId = generateDeterministicId("already-enqueued")
    // 4. Terminal expired workflow (should NOT be enqueued)
    const terminalWorkflowId = generateDeterministicId("terminal-workflow")

    // Setup required references
    const commonDate = new Date()
    const occ = BigInt(0)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).organizationAdmin.create({
      data: {id: orgAdminId, role: "OWNER", createdAt: commonDate, updatedAt: commonDate, occ}
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).space.create({
      data: {id: spaceId, name: "Test Space", createdAt: commonDate, updatedAt: commonDate, occ}
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).workflowTemplate.create({
      data: {
        id: templateId,
        name: "Test Template",
        spaceId,
        approvalRule: "",
        actions: [],
        createdAt: commonDate,
        updatedAt: commonDate,
        status: "DRAFT",
        version: 1,
        occ
      }
    })

    // Create Workflows
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).workflow.createMany({
      data: [
        {
          id: expiredWorkflowId,
          name: "Expired",
          workflowTemplateId: templateId,
          status: "EVALUATION_IN_PROGRESS",
          expiresAt: pastDate,
          recalculationRequired: false,
          createdAt: commonDate,
          updatedAt: commonDate,
          occ
        },
        {
          id: futureWorkflowId,
          name: "Future",
          workflowTemplateId: templateId,
          status: "EVALUATION_IN_PROGRESS",
          expiresAt: futureDate,
          recalculationRequired: false,
          createdAt: commonDate,
          updatedAt: commonDate,
          occ
        },
        {
          id: alreadyEnqueuedWorkflowId,
          name: "Already Enqueued",
          workflowTemplateId: templateId,
          status: "EVALUATION_IN_PROGRESS",
          expiresAt: pastDate,
          recalculationRequired: true,
          createdAt: commonDate,
          updatedAt: commonDate,
          occ
        },
        {
          id: terminalWorkflowId,
          name: "Terminal",
          workflowTemplateId: templateId,
          status: "APPROVED",
          expiresAt: pastDate,
          recalculationRequired: false,
          createdAt: commonDate,
          updatedAt: commonDate,
          occ
        }
      ]
    })

    // Trigger sweep
    const result = await recalcService.sweepExpiredWorkflows()()
    expect(result._tag).toBe("Right")

    // Verify Database state
    const expiredWorkflow = await prisma.workflow.findUnique({where: {id: expiredWorkflowId}})
    expect(expiredWorkflow?.recalculationRequired).toBe(true)

    const futureWorkflow = await prisma.workflow.findUnique({where: {id: futureWorkflowId}})
    expect(futureWorkflow?.recalculationRequired).toBe(false)

    const alreadyEnqueuedWorkflow = await prisma.workflow.findUnique({where: {id: alreadyEnqueuedWorkflowId}})
    expect(alreadyEnqueuedWorkflow?.recalculationRequired).toBe(true) // still true

    const terminalWorkflow = await prisma.workflow.findUnique({where: {id: terminalWorkflowId}})
    expect(terminalWorkflow?.recalculationRequired).toBe(false)

    // Verify Queue state
    const jobs = await workflowQueue.getJobs(["waiting", "active", "delayed"])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.data.workflowId).toBe(expiredWorkflowId)
  })
})
