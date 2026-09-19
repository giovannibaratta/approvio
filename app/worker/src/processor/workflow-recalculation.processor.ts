import {Processor, Process} from "@nestjs/bull"
import {Inject, Logger} from "@nestjs/common"
import {Job} from "bull"
import {WorkflowRecalculationService} from "@services/workflow/workflow-recalculation.service"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WORKFLOW_STATUS_RECALCULATION_QUEUE} from "@external"
import {isUUIDv7} from "@utils"
import {TenantEvent, TenantEventFactory} from "@domain"
import * as E from "fp-ts/Either"

@Processor(WORKFLOW_STATUS_RECALCULATION_QUEUE)
export class WorkflowRecalculationProcessor {
  constructor(
    @Inject(WorkflowRecalculationService)
    private readonly recalcService: WorkflowRecalculationService
  ) {}

  @Process("recalculate-workflow")
  async process(job: Pick<Job<TenantEvent>, "data" | "attemptsMade" | "opts" | "id">): Promise<void> {
    const validated = TenantEventFactory.validate(job.data)
    if (E.isLeft(validated)) throw new Error(`Invalid recalculation event: ${validated.left}`)
    const event = validated.right
    if (event.type !== "workflow.recalculate") throw new Error("Expected a workflow.recalculate tenant event")
    const workflowId = event.workflowId

    Logger.log(
      `Processing recalculation for workflow ${workflowId} (attempt ${job.attemptsMade + 1}/${job.opts.attempts})`
    )

    const attempt = job.attemptsMade + 1

    if (!isUUIDv7(workflowId)) {
      Logger.error(`Invalid workflow ID format: ${workflowId}`, {
        workflowId,
        attempt
      })
      throw new Error(`Invalid workflow ID format: ${workflowId}`)
    }

    const startTime = Date.now()

    return pipe(
      this.recalcService.recalculateWorkflowStatus(event),
      TE.match(
        error => {
          const duration = Date.now() - startTime
          Logger.error(`Failed to recalculate workflow ${workflowId} after ${duration}ms: ${error}`, {
            workflowId,
            error,
            duration,
            attempt
          })
          // Throw error to trigger Bull retry
          throw new Error(`Workflow recalculation failed: ${error}`)
        },
        () => {
          const duration = Date.now() - startTime
          Logger.log(`Successfully recalculated workflow ${workflowId} in ${duration}ms`, {
            workflowId,
            duration,
            attempt
          })
          return void 0
        }
      )
    )()
  }
}
