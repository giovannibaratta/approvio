import {TenantOutboxService} from "@services/durable-work/tenant-outbox.service"
import {Test, TestingModule, TestingModuleBuilder} from "@nestjs/testing"
import {WorkerModule} from "../../src/worker.module"
import {WorkflowEventsProcessor} from "../../src/processor/workflow-events.processor"
import {WorkflowActionWebhookProcessor} from "../../src/processor/workflow-action-webhook.processor"
import {WorkflowActionEmailProcessor} from "../../src/processor/workflow-action-email.processor"
import {WorkflowActionSlackProcessor} from "../../src/processor/workflow-action-slack.processor"
import {WorkflowRecalculationProcessor} from "../../src/processor/workflow-recalculation.processor"
import {WorkflowExpirationSweepProcessor} from "../../src/processor/workflow-expiration-sweep.processor"
import {Process} from "@nestjs/bull"
import {Injectable} from "@nestjs/common/interfaces"
import {SilentLogger} from "@test/logger-helpers"
import {TenantEvent, TaskCreationFactory} from "@domain"
import {TASK_REPOSITORY_TOKEN, TaskGenerationRequest, TaskRepository} from "@services/task/interfaces"
import {TenantOutboxRepository, TenantTransactionManager} from "@services"
import {QueueProvider} from "@services/queue/interface"
import * as TE from "fp-ts/TaskEither"
import {unwrapRight} from "@utils/either"

/**
 * Suppress queue delivery so a Bull consumer cannot race a test's explicit processor call.
 * This provider reports success without exercising queue transport or recovery scheduling.
 */
export class InertQueueProvider implements QueueProvider {
  enqueue(..._args: Parameters<QueueProvider["enqueue"]>): ReturnType<QueueProvider["enqueue"]> {
    return TE.right(undefined)
  }

  requestUsageCacheRecovery(
    ..._args: Parameters<QueueProvider["requestUsageCacheRecovery"]>
  ): ReturnType<QueueProvider["requestUsageCacheRecovery"]> {
    return TE.right(undefined)
  }

  checkHealth(): ReturnType<QueueProvider["checkHealth"]> {
    return TE.right(undefined)
  }
}

/**
 * All worker processors that should be considered for mocking
 */
const ALL_WORKER_PROCESSORS = [
  WorkflowEventsProcessor,
  WorkflowActionWebhookProcessor,
  WorkflowActionEmailProcessor,
  WorkflowActionSlackProcessor,
  WorkflowRecalculationProcessor,
  WorkflowExpirationSweepProcessor
]

class MockProcessor {
  @Process()
  async process() {}
}

/**
 * Sets up a worker test module with selective processor mocking
 *
 * This is useful to have a test module that is aligned to the real implementation but without
 * the interference of other processors that are not being tested, since they might react to the
 * event produced by the processor under test.
 *
 * @param processorsToKeep - Array of processor classes that should NOT be mocked
 * @returns TestingModuleBuilder configured with the specified processors mocked
 *
 * @example
 * // Mock all processors except WorkflowEventsProcessor
 * const moduleBuilder = setupWorkerTestModule([WorkflowEventsProcessor])
 *   .overrideProvider(SomeAdditionalService)
 *   .useValue(mockService)
 *
 * const module = await moduleBuilder.compile()
 */
export function setupWorkerTestModule(processorsToKeep: Array<Injectable> = []): TestingModuleBuilder {
  const builder = Test.createTestingModule({
    imports: [WorkerModule]
  }).setLogger(new SilentLogger())

  // Mock all processors except those in processorsToKeep
  ALL_WORKER_PROCESSORS.forEach(processor => {
    if (!processorsToKeep.includes(processor)) builder.overrideProvider(processor).useClass(MockProcessor)
  })

  return builder
}

export function appendTenantEvent(
  transactionManager: TenantTransactionManager,
  outbox: TenantOutboxRepository,
  event: TenantEvent
) {
  const context = {organizationId: event.organizationId}
  return transactionManager.execute(context, () =>
    new TenantOutboxService(outbox, transactionManager).append(context, event)
  )
}

/** Seeds task delivery fixtures without running generation receipts or queue publication. */
export async function persistTaskFixture(module: TestingModule, request: TaskGenerationRequest) {
  const {task, metadata} = request.request

  const result = await module
    .get<TaskRepository>(TASK_REPOSITORY_TOKEN)
    .createEventTask(
      {organizationId: task.organizationId},
      request,
      TaskCreationFactory.create(task, request.kind, metadata.eventId, metadata.availableAt)
    )()

  const event = unwrapRight(result)
  if (event === undefined) throw new Error("Task fixture already exists")

  return event
}
