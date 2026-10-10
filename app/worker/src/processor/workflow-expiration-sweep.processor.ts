import {InjectQueue, Process, Processor} from "@nestjs/bull"
import {Inject, Logger} from "@nestjs/common"
import {OrganizationId, isOrganizationId} from "@domain"
import {Job, Queue} from "bull"
import {WorkflowRecalculationService} from "@services/workflow/workflow-recalculation.service"
import {LeverService} from "@services/lever"
import {OrganizationService} from "@services/tenancy"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WORKFLOW_EXPIRATION_SWEEP_INTERVAL_MS, WORKFLOW_EXPIRATION_SWEEP_QUEUE, RedisLock} from "@external"

const ORGANIZATION_PAGE_SIZE = 100
const ORGANIZATION_SWEEP_BATCH_SIZE = 100
const EXPIRED_WORKFLOW_BATCH_SIZE = 1000

interface ExpirationSweepCandidate {
  readonly organizationId: OrganizationId
  readonly lastSweptAt?: Date
}

@Processor(WORKFLOW_EXPIRATION_SWEEP_QUEUE)
export class WorkflowExpirationSweepProcessor {
  constructor(
    @InjectQueue(WORKFLOW_EXPIRATION_SWEEP_QUEUE)
    private readonly sweepQueue: Queue,
    @Inject(WorkflowRecalculationService)
    private readonly recalculation: Pick<
      WorkflowRecalculationService,
      | "scheduleExpiredWorkflowRecalculations"
      | "getDueWorkflowExpirationSchedule"
      | "markWorkflowExpirationSweepScheduled"
    >,
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
        return this.scheduleOrganizations(new Date())
      }),
      TE.match(
        error => {
          if (
            typeof error === "object" &&
            error !== null &&
            "type" in error &&
            error.type === "lock_already_acquired"
          ) {
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
        this.recalculation.scheduleExpiredWorkflowRecalculations(
          {organizationId},
          new Date(),
          EXPIRED_WORKFLOW_BATCH_SIZE
        )
      ),
      TE.match(
        error => {
          if (
            typeof error === "object" &&
            error !== null &&
            "type" in error &&
            error.type === "lock_already_acquired"
          ) {
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

  private scheduleOrganizations(now: Date): TE.TaskEither<"unknown_error", void> {
    const scan = (
      afterId: string | undefined,
      candidates: ReadonlyArray<ExpirationSweepCandidate>
    ): TE.TaskEither<"unknown_error", ReadonlyArray<ExpirationSweepCandidate>> =>
      pipe(
        this.organizations.listBatch(ORGANIZATION_PAGE_SIZE, afterId),
        TE.mapLeft(() => "unknown_error" as const),
        TE.chainW(organizations => {
          const scheduleLookups = organizations.map(organization =>
            pipe(
              this.recalculation.getDueWorkflowExpirationSchedule(
                {organizationId: organization.id},
                now,
                new Date(now.getTime() - WORKFLOW_EXPIRATION_SWEEP_INTERVAL_MS)
              ),
              TE.mapLeft(() => "unknown_error" as const)
            )
          )
          return pipe(
            TE.sequenceArray(scheduleLookups),
            TE.chainW(schedules => {
              const due = schedules.flatMap(schedule => (schedule ? [schedule] : []))
              const nextCandidates = [...candidates, ...due]
              const lastOrganization = organizations[organizations.length - 1]
              if (organizations.length < ORGANIZATION_PAGE_SIZE || !lastOrganization) return TE.right(nextCandidates)
              return scan(lastOrganization.id, nextCandidates)
            }),
            TE.mapLeft(() => "unknown_error" as const)
          )
        })
      )

    const oldestFirst = (left: ExpirationSweepCandidate, right: ExpirationSweepCandidate): number => {
      if (left.lastSweptAt === undefined)
        return right.lastSweptAt === undefined ? left.organizationId.localeCompare(right.organizationId) : -1
      if (right.lastSweptAt === undefined) return 1
      return (
        left.lastSweptAt.getTime() - right.lastSweptAt.getTime() ||
        left.organizationId.localeCompare(right.organizationId)
      )
    }

    return pipe(
      scan(undefined, []),
      TE.chainW(candidates =>
        pipe(
          TE.sequenceArray(
            [...candidates]
              .sort(oldestFirst)
              .slice(0, ORGANIZATION_SWEEP_BATCH_SIZE)
              .map(candidate =>
                pipe(
                  this.recalculation.markWorkflowExpirationSweepScheduled(
                    {organizationId: candidate.organizationId},
                    now,
                    new Date(now.getTime() - WORKFLOW_EXPIRATION_SWEEP_INTERVAL_MS)
                  ),
                  TE.mapLeft(() => "unknown_error" as const),
                  TE.chainW(claimed =>
                    claimed
                      ? TE.tryCatch(
                          () =>
                            this.sweepQueue.add(
                              "sweep-organization",
                              {organizationId: candidate.organizationId},
                              {
                                jobId: `${candidate.organizationId}-${Math.floor(
                                  now.getTime() / WORKFLOW_EXPIRATION_SWEEP_INTERVAL_MS
                                )}`,
                                attempts: 3,
                                backoff: {type: "exponential", delay: 2000},
                                removeOnComplete: {age: 604800},
                                removeOnFail: {age: 604800}
                              }
                            ),
                          () => "unknown_error" as const
                        )
                      : TE.right(undefined)
                  )
                )
              )
          ),
          TE.map(() => undefined),
          TE.mapLeft(() => "unknown_error" as const)
        )
      )
    )
  }
}
