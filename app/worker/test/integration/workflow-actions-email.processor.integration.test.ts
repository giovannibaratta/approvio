import {WorkflowActionEmailProcessor} from "../../src/processor/workflow-action-email.processor"
import {TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {createMockSpaceInDb, createMockWorkflowTemplateInDb, MockConfigProvider} from "@test/mock-data"
import {cleanDatabase, prepareDatabase, prepareRedisPrefix, cleanRedisByPrefix} from "@test/database"
import {DatabaseClient} from "@external"
import {PrismaClient} from "@prisma/client"
import {setupWorkerTestModule} from "./test-helpers"
import {WorkflowActionEmailTaskFactory, TaskStatus, WorkflowStatus} from "@domain"
import {Job} from "bull"
import {WorkflowActionEmailEvent} from "@domain/events"
import {randomUUID} from "crypto"
import {isLeft} from "fp-ts/lib/Either"
import axios from "axios"
import {isNone} from "fp-ts/lib/Option"
import {EmailService} from "@services/email/email.service"
import * as TE from "fp-ts/TaskEither"

async function createWorkflowWithEmailTask(
  prisma: PrismaClient,
  recipients: string[] = ["test@localhost.com"],
  subject: string = "Test Email Subject",
  body: string = "<h1>Test Email Body</h1>"
) {
  // Create a space and template first
  const spaceId = (await createMockSpaceInDb(prisma)).id
  const template = await createMockWorkflowTemplateInDb(prisma, {spaceId})

  // Create a workflow
  const workflow = await prisma.workflow.create({
    data: {
      id: randomUUID(),
      name: "Test-Email-Workflow",
      status: WorkflowStatus.EVALUATION_IN_PROGRESS,
      workflowTemplateId: template.id,
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      updatedAt: new Date(),
      occ: 0n,
      recalculationRequired: false
    }
  })

  // Create an email task
  const emailTaskEither = WorkflowActionEmailTaskFactory.newWorkflowActionEmailTask({
    id: randomUUID(),
    workflowId: workflow.id,
    recipients,
    subject,
    body
  })

  if (isLeft(emailTaskEither)) {
    throw new Error(`Failed to create email task for testing: ${JSON.stringify(emailTaskEither.left)}`)
  }

  const emailTask = emailTaskEither.right

  await prisma.workflowActionsEmailTask.create({
    data: {
      id: emailTask.id,
      workflowId: emailTask.workflowId,
      recipients: emailTask.recipients,
      subject: emailTask.subject,
      body: emailTask.body,
      status: emailTask.status,
      retryCount: emailTask.retryCount,
      createdAt: emailTask.createdAt,
      updatedAt: emailTask.updatedAt,
      occ: emailTask.occ
    }
  })

  return {workflowId: workflow.id, taskId: emailTask.id}
}

describe("Workflow Action Email Processor Integration", () => {
  let processor: WorkflowActionEmailProcessor
  let emailService: EmailService
  let prisma: PrismaClient
  let redisPrefix: string
  let module: TestingModule
  let mailpitEndpoint: string
  let senderEmail: string

  beforeEach(async () => {
    const originalEmailConfig = ConfigProvider.validateEmailProviderConfig()

    if (isNone(originalEmailConfig)) throw new Error("Email provider configuration is not valid.")

    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    const mailtpitEnvVariable = process.env.MAILPIT_API_ENDPOINT

    if (!mailtpitEnvVariable)
      throw new Error("MAILPIT_API_ENDPOINT environment variable is not set. This test requires Mailpit to be running.")

    mailpitEndpoint = mailtpitEnvVariable

    senderEmail = `test-sender-${randomUUID()}@localhost.com`

    try {
      const moduleBuilder = setupWorkerTestModule([WorkflowActionEmailProcessor])
        .overrideProvider(ConfigProvider)
        .useValue(
          MockConfigProvider.fromOriginalProvider({
            dbConnectionUrl: isolatedDb,
            redisPrefix,
            emailProviderConfig: {
              ...originalEmailConfig.value,
              senderEmail
            }
          })
        )

      module = await moduleBuilder.compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    processor = module.get<WorkflowActionEmailProcessor>(WorkflowActionEmailProcessor)
    emailService = module.get<EmailService>(EmailService)
    prisma = module.get(DatabaseClient)

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
    it("should successfully process an email task and update task status to COMPLETED", async () => {
      // Given: An email task in PENDING status
      const recipient = `recipient-${randomUUID()}@localhost.com`
      const {taskId, workflowId} = await createWorkflowWithEmailTask(prisma, [recipient])

      // Create the event to process
      const event: WorkflowActionEmailEvent = {
        taskId: taskId,
        workflowId: workflowId
      }

      const job = {
        data: event,
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "test-job-email-1"
      } as Job<WorkflowActionEmailEvent>

      // When: Process the email task
      await processor.handleEmailAction(job)

      // Expect: The email was sent (captured by Mailpit)
      // Note: We search by recipient to avoid interference with other tests
      const response = await axios.get(`http://${mailpitEndpoint}/api/v1/search?query=to:"${recipient}"`)
      const messages = response.data.messages
      expect(messages).toHaveLength(1)
      expect(messages[0].To[0].Address).toBe(recipient)
      expect(messages[0].From.Address).toBe(senderEmail)

      // And: The task was updated to COMPLETED status
      const updatedTask = await prisma.workflowActionsEmailTask.findUnique({
        where: {id: taskId}
      })

      expect(updatedTask).toBeDefined()
      expect(updatedTask?.status).toBe(TaskStatus.COMPLETED)
      expect(updatedTask?.retryCount).toBe(0)
      expect(updatedTask?.errorReason).toBeNull()
    })

    it("should handle email failures and update task status to ERROR", async () => {
      // Given: An email task in PENDING status
      const {taskId, workflowId} = await createWorkflowWithEmailTask(prisma)

      // Mock the email service to fail
      const emailSpy = jest
        .spyOn(emailService, "sendEmail")
        .mockReturnValueOnce(TE.left("email_unknown_error" as const))

      // Create the event to process
      const event: WorkflowActionEmailEvent = {
        taskId: taskId,
        workflowId: workflowId
      }

      const job = {
        data: event,
        attemptsMade: 0,
        opts: {attempts: 3},
        id: "test-job-email-2"
      } as Job<WorkflowActionEmailEvent>

      // When: Process the email task
      await processor.handleEmailAction(job)

      // Expect: The task was updated to ERROR status
      const updatedTask = await prisma.workflowActionsEmailTask.findUnique({
        where: {id: taskId}
      })

      expect(updatedTask).toBeDefined()
      expect(updatedTask?.status).toBe(TaskStatus.ERROR)
      expect(updatedTask?.retryCount).toBe(1)
      expect(updatedTask?.errorReason).toContain("Unable to send email")

      emailSpy.mockRestore()
    })
  })
})
