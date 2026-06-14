import {Processor, Process, InjectQueue} from "@nestjs/bull"
import {Logger} from "@nestjs/common"
import {Queue} from "bull"
import {WorkflowRecalculationService} from "@services/workflow/workflow-recalculation.service"
import {LeverService} from "@services/lever"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WORKFLOW_EXPIRATION_SWEEP_QUEUE, RedisLock} from "@external"

@Processor(WORKFLOW_EXPIRATION_SWEEP_QUEUE)
export class WorkflowExpirationSweepProcessor {
  constructor(
    @InjectQueue(WORKFLOW_EXPIRATION_SWEEP_QUEUE)
    private readonly sweepQueue: Queue,
    private readonly recalcService: WorkflowRecalculationService,
    private readonly leverService: LeverService
  ) {}

  @Process("sweep-expired-workflows")
  async sweepExpired(): Promise<void> {
    const leverResult = await this.leverService.isLeverActive("disable_workflow_expiration_sweep")()

    if (leverResult) {
      Logger.warn("Workflow expiration sweep is disabled by lever (disable_workflow_expiration_sweep). Skipping.")
      return
    }

    const lockKey = "lock:sweep-expired-workflows"
    const lockTtl = 300000 // 5 minutes
    const timeout = 240000 // 4 minutes - strictly less than lock TTL to guarantee safety

    const lock = new RedisLock(this.sweepQueue.client, lockKey, lockTtl)

    await pipe(
      lock.runLocked(timeout, () => {
        Logger.log("Running periodic sweep of expired workflows...")
        return this.recalcService.sweepExpiredWorkflows()
      }),
      TE.match(
        error => {
          if (error !== "unknown_error" && error.type === "lock_already_acquired") {
            Logger.warn("Another sweep-expired-workflows job is currently in progress. Skipping.")
            return
          }
          Logger.error(`Failed to sweep expired workflows: ${JSON.stringify(error)}`)
          throw new Error(`Sweep failed: ${JSON.stringify(error)}`)
        },
        () => {
          Logger.log("Successfully completed expired workflows sweep")
        }
      )
    )()
  }
}
