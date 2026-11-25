import {Test, TestingModule} from "@nestjs/testing"
import {Prisma} from "@prisma/client"
import {WorkerDatabaseClient} from "@external/database/capability-database-client"
import {PrismaTaskRepository} from "@external/database/task.repository"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {randomOrgId} from "@test/organization-id"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"
import * as TE from "fp-ts/TaskEither"
import {TaskGetErrorEmailTask, TaskGetErrorSlackTask, TaskGetErrorWebhookTask} from "@services/task/interfaces"

describe.each(["email", "slack", "webhook"] as const)("%s task payload failures", kind => {
  let module: TestingModule

  afterEach(async () => {
    await module?.close()
  })

  async function fixture() {
    const workers = {
      transactional: jest
        .fn<ReturnType<WorkerDatabaseClient["transactional"]>, Parameters<WorkerDatabaseClient["transactional"]>>()
        .mockResolvedValue(null)
    }
    const encryption = {
      decrypt: jest.fn<ReturnType<TenantEncryptionService["decrypt"]>, Parameters<TenantEncryptionService["decrypt"]>>()
    } satisfies Pick<TenantEncryptionService, "decrypt">
    module = await Test.createTestingModule({
      providers: [
        PrismaTaskRepository,
        {provide: WorkerDatabaseClient, useValue: workers},
        {provide: TenantEncryptionService, useValue: encryption}
      ]
    }).compile()
    const repository = module.get(PrismaTaskRepository)
    const context = {organizationId: randomOrgId()}
    const taskId = uuidv7()
    const operations = {
      email: () => repository.getEmailTask(context, taskId)(),
      slack: () => repository.getSlackTask(context, taskId)(),
      webhook: () => repository.getWebhookTask(context, taskId)()
    }
    const load: TE.TaskEither<
      TaskGetErrorEmailTask | TaskGetErrorSlackTask | TaskGetErrorWebhookTask,
      unknown
    > = async () => operations[kind]()
    return {load, workers, encryption, context, taskId}
  }

  async function persistedFixture() {
    const test = await fixture()
    const now = new Date()
    const row = {
      id: test.taskId,
      organizationId: test.context.organizationId,
      workflowId: uuidv7(),
      eventId: uuidv7(),
      actionIndex: 0,
      encPayload: "test ciphertext",
      state: "ready",
      leaseOwner: null,
      leaseUntil: null,
      fencing: 0n,
      availableAt: now,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      occ: 0n
    } satisfies Prisma.WorkflowActionsEmailTaskGetPayload<object>
    test.workers.transactional.mockResolvedValue(row)
    return test
  }

  it("marks a missing task as a permanent failure", async () => {
    // Given
    const {load} = await fixture()

    // When
    const result = await load()

    // Expect
    expect(result).toBeLeftOf({code: "task_not_found", retryable: false})
  })

  it("marks local decryption failures as permanent", async () => {
    // Given
    const {load, encryption} = await persistedFixture()
    encryption.decrypt.mockReturnValue(TE.left("decryption_failed"))

    // When
    const result = await load()

    // Expect
    expect(result).toBeLeftOf({code: "decryption_failed", retryable: false})
  })

  it("distinguishes malformed decrypted JSON from decryption failure", async () => {
    // Given
    const {load, encryption} = await persistedFixture()
    encryption.decrypt.mockReturnValue(TE.right("{invalid JSON"))

    // When
    const result = await load()

    // Expect
    expect(result).toBeLeftOf({code: "task_payload_invalid", retryable: false})
  })

  it("rejects decrypted JSON that is not a task payload object", async () => {
    // Given
    const {load, encryption} = await persistedFixture()
    encryption.decrypt.mockReturnValue(TE.right("[]"))

    // When
    const result = await load()

    // Expect
    expect(result).toBeLeftOf({code: "task_payload_invalid", retryable: false})
  })
})
