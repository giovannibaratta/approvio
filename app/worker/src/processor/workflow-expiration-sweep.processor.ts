// TODO(long-term): do not import directly the RedisLock
import {InjectQueue, Process, Processor} from "@nestjs/bull"
import {Logger} from "@nestjs/common"
import {
  BoundaryError,
  OrganizationId,
  isOrganizationId,
  WorkflowExpirationSchedule,
  WorkflowExpirationScheduleValidationError,
  OrganizationSummaryValidationError
} from "@domain"
import {Job, Queue} from "bull"
import {WorkflowRecalculationService} from "@services/workflow/workflow-recalculation.service"
import {LeverService} from "@services/lever"
import {OrganizationService} from "@services/tenancy"
import {RepositoryDependencyError, UnknownError} from "@services/error"
import {TransactionError} from "@services/transaction/interfaces"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WORKFLOW_EXPIRATION_SWEEP_INTERVAL_MS, WORKFLOW_EXPIRATION_SWEEP_QUEUE, RedisLock} from "@external"

const ORGANIZATION_PAGE_SIZE = 100
const ORGANIZATION_SWEEP_BATCH_SIZE = 100
const EXPIRED_WORKFLOW_BATCH_SIZE = 1000

@Processor(WORKFLOW_EXPIRATION_SWEEP_QUEUE)
export class WorkflowExpirationSweepProcessor {
  constructor(
    @InjectQueue(WORKFLOW_EXPIRATION_SWEEP_QUEUE)
    private readonly sweepQueue: Queue,
    private readonly recalcService: WorkflowRecalculationService,
    private readonly leverService: LeverService,
    private readonly organizations: OrganizationService
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
        Logger.log("Selecting organizations with due workflow expirations...")
        return this.scheduleOrganizations()
      }),
      TE.match(
        error => {
          if (typeof error !== "string" && error.type === "lock_already_acquired") {
            Logger.warn("Another sweep-expired-workflows job is currently in progress. Skipping.")
            return
          }
          Logger.error(`Failed to sweep expired workflows: ${JSON.stringify(error)}`)
          throw new Error(`Sweep failed: ${JSON.stringify(error)}`)
        },
        () => {
          Logger.log("Successfully completed workflow expiration scheduling")
        }
      )
    )()
  }

  @Process("sweep-organization")
  async sweepOrganization(job: Job<{readonly organizationId: string}>): Promise<void> {
    const {organizationId} = job.data
    if (!isOrganizationId(organizationId)) throw new Error("Invalid organization ID in sweep job")
    const lockKey = `lock:sweep-expired-workflows:${organizationId}`
    const lock = new RedisLock(this.sweepQueue.client, lockKey, 300000)

    await pipe(
      lock.runLocked(240000, () =>
        this.recalcService.scheduleExpiredWorkflowRecalculations(
          {organizationId},
          new Date(),
          EXPIRED_WORKFLOW_BATCH_SIZE
        )
      ),
      TE.match(
        error => {
          if (typeof error !== "string" && error.type === "lock_already_acquired") {
            Logger.warn(`Workflow expiration sweep is already running for organization ${organizationId}. Skipping.`)
            return
          }
          Logger.error(`Failed to sweep expired workflows for organization ${organizationId}: ${JSON.stringify(error)}`)
          throw new Error(`Organization workflow expiration sweep failed: ${JSON.stringify(error)}`)
        },
        () => Logger.log(`Completed workflow expiration sweep for organization ${organizationId}`)
      )
    )()
  }

  private scheduleOrganizations() {
    const now = new Date()
    const scheduledBefore = new Date(now.getTime() - WORKFLOW_EXPIRATION_SWEEP_INTERVAL_MS)

    return pipe(
      this.scanOrganizations(now, scheduledBefore),
      TE.map(candidates => [...candidates].sort(this.oldestFirst).slice(0, ORGANIZATION_SWEEP_BATCH_SIZE)),
      TE.chainW(TE.traverseArray(candidate => this.enqueueSweep(candidate, now, scheduledBefore))),
      TE.map(() => undefined)
    )
  }

  private scanOrganizations(
    now: Date,
    scheduledBefore: Date,
    afterId?: string,
    candidates: ReadonlyArray<WorkflowExpirationSchedule> = []
  ): TE.TaskEither<SweepSchedulingError, ReadonlyArray<WorkflowExpirationSchedule>> {
    return pipe(
      this.organizations.listBatch(ORGANIZATION_PAGE_SIZE, afterId),
      TE.chainW(organizations =>
        pipe(
          this.findDueSchedules(
            organizations.map(organization => organization.id),
            now,
            scheduledBefore
          ),
          TE.chainW(due => {
            const nextCandidates = [...candidates, ...due]
            const lastOrganization = organizations[organizations.length - 1]
            if (organizations.length < ORGANIZATION_PAGE_SIZE || !lastOrganization) return TE.right(nextCandidates)
            return this.scanOrganizations(now, scheduledBefore, lastOrganization.id, nextCandidates)
          })
        )
      )
    )
  }

  private findDueSchedules(organizationIds: ReadonlyArray<OrganizationId>, now: Date, scheduledBefore: Date) {
    return pipe(
      organizationIds,
      TE.traverseArray(organizationId =>
        this.recalcService.getDueWorkflowExpirationSchedule({organizationId}, now, scheduledBefore)
      ),
      TE.map(schedules => schedules.flatMap(schedule => (schedule ? [schedule] : [])))
    )
  }

  private oldestFirst(this: void, left: WorkflowExpirationSchedule, right: WorkflowExpirationSchedule): number {
    if (left.lastSweptAt === undefined)
      return right.lastSweptAt === undefined ? left.organizationId.localeCompare(right.organizationId) : -1
    if (right.lastSweptAt === undefined) return 1
    return (
      left.lastSweptAt.getTime() - right.lastSweptAt.getTime() ||
      left.organizationId.localeCompare(right.organizationId)
    )
  }

  private enqueueSweep(candidate: WorkflowExpirationSchedule, now: Date, scheduledBefore: Date) {
    return pipe(
      this.recalcService.markWorkflowExpirationSweepScheduled(
        {organizationId: candidate.organizationId},
        now,
        scheduledBefore
      ),
      TE.chainW(claimed => (claimed ? this.addOrganizationSweep(candidate.organizationId, now) : TE.right(undefined)))
    )
  }

  private addOrganizationSweep(organizationId: OrganizationId, now: Date) {
    return pipe(
      TE.tryCatch(
        () =>
          this.sweepQueue.add(
            "sweep-organization",
            {organizationId},
            {
              jobId: `${organizationId}-${Math.floor(now.getTime() / WORKFLOW_EXPIRATION_SWEEP_INTERVAL_MS)}`,
              attempts: 3,
              backoff: {type: "exponential", delay: 2000},
              removeOnComplete: {age: 604800},
              removeOnFail: {age: 604800}
            }
          ),
        (): UnknownError => "unknown_error"
      ),
      TE.map(() => undefined)
    )
  }
}

type SweepSchedulingError =
  | OrganizationSummaryValidationError
  | BoundaryError
  | RepositoryDependencyError
  | UnknownError
  | TransactionError
  | WorkflowExpirationScheduleValidationError
