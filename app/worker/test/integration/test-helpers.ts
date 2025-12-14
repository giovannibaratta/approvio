// eslint-disable-next-line node/no-unpublished-import
import {Test, TestingModuleBuilder} from "@nestjs/testing"
import {WorkerModule} from "../../src/worker.module"
import {WorkflowEventsProcessor} from "../../src/processor/workflow-events.processor"
import {WorkflowRecalculationProcessor} from "../../src/processor/workflow-recalculation.processor"
import {Process} from "@nestjs/bull"
import {Injectable} from "@nestjs/common/interfaces"

/**
 * All worker processors that should be considered for mocking
 */
const ALL_WORKER_PROCESSORS = [WorkflowEventsProcessor, WorkflowRecalculationProcessor]

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
  })

  // Mock all processors except those in processorsToKeep
  ALL_WORKER_PROCESSORS.forEach(processor => {
    if (!processorsToKeep.includes(processor)) {
      builder.overrideProvider(processor).useClass(MockProcessor)
    }
  })

  return builder
}
