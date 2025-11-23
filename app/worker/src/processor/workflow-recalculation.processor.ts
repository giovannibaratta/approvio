import {Processor, Process} from "@nestjs/bull"
import {Logger} from "@nestjs/common"
import {Job} from "bull"
import {WorkflowRecalculationService} from "@services/workflow/workflow-recalculation.service"
import {RecalculationJobData} from "@external/queue/queue.provider"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WORKFLOW_STATUS_RECALCULATION_QUEUE} from "@external"
import {isUUIDv4} from "@utils"

@Processor(WORKFLOW_STATUS_RECALCULATION_QUEUE)
export class WorkflowRecalculationProcessor {
  constructor(private readonly recalcService: WorkflowRecalculationService) {}

  @Process("recalculate-workflow")
  async process(job: Job<RecalculationJobData>): Promise<void> {
    const {workflowId} = job.data

    Logger.log(
      `Processing recalculation for workflow ${workflowId} (attempt ${job.attemptsMade + 1}/${job.opts.attempts})`
    )

    const attempt = job.attemptsMade + 1

    if (!isUUIDv4(workflowId)) {
      Logger.error(`Invalid workflow ID format: ${workflowId}`, {
        workflowId,
        attempt
      })
      throw new Error(`Invalid workflow ID format: ${workflowId}`)
    }

    const startTime = Date.now()

    return pipe(
      this.recalcService.recalculateWorkflowStatusByWorkflowId(workflowId),
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

  /**
   * Called when job completes successfully.
   */
  onCompleted(job: Job<RecalculationJobData>) {
    Logger.log(`Recalculation job ${job.id} completed`, {
      workflowId: job.data.workflowId
    })
  }

  /**
   * Called when job fails after all retries.
   */
  onFailed(job: Job<RecalculationJobData> | undefined, error: Error) {
    if (!job) {
      Logger.error("Recalculation job failed with no job data", {error: error.message})
      return
    }

    Logger.error(`Recalculation job ${job.id} failed after all retries`, {
      workflowId: job.data.workflowId,
      error: error.message,
      attemptsMade: job.attemptsMade
    })
  }
}
