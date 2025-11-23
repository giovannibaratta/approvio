import {Inject, Injectable, Logger} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {evaluateWorkflowStatus} from "@domain"
import {VOTE_REPOSITORY_TOKEN, VoteRepository, FindVotesError} from "../vote/interfaces"
import {WORKFLOW_REPOSITORY_TOKEN, WorkflowRepository, WorkflowGetError, WorkflowUpdateError} from "./interfaces"

export type WorkflowRecalculationError = WorkflowGetError | FindVotesError | WorkflowUpdateError

@Injectable()
export class WorkflowRecalculationService {
  constructor(
    @Inject(WORKFLOW_REPOSITORY_TOKEN)
    private readonly workflowRepo: WorkflowRepository,
    @Inject(VOTE_REPOSITORY_TOKEN)
    private readonly voteRepo: VoteRepository
  ) {}

  /**
   * Recalculates the status of a workflow based on its votes.
   * Sets recalculationRequired to false after successful recalculation.
   * @param workflowId The ID of the workflow to recalculate.
   * @returns A TaskEither with void or a recalculation error.
   */
  recalculateWorkflowStatusByWorkflowId(workflowId: string): TaskEither<WorkflowRecalculationError, void> {
    const getWorkflow = () => this.workflowRepo.getWorkflowById(workflowId, {occ: true, workflowTemplate: true})
    const getVotes = () => this.voteRepo.getVotesByWorkflowId(workflowId)

    return pipe(
      TE.Do,
      TE.bindW("workflow", getWorkflow),
      TE.bindW("votes", getVotes),
      TE.bindW("workflowWithUpdatedStatus", ({workflow, votes}) =>
        TE.fromEither(evaluateWorkflowStatus(workflow, votes))
      ),
      TE.chainFirstIOK(({workflowWithUpdatedStatus}) =>
        TE.fromIO(() =>
          Logger.log(`Workflow ${workflowWithUpdatedStatus.id} new status: ${workflowWithUpdatedStatus.status}`)
        )
      ),
      TE.chainW(({workflow, workflowWithUpdatedStatus}) =>
        this.workflowRepo.updateWorkflowConcurrentSafe(workflowWithUpdatedStatus.id, workflow.occ, {
          updatedAt: new Date(),
          status: workflowWithUpdatedStatus.status,
          recalculationRequired: false
        })
      ),
      TE.chainFirstIOK(workflow => TE.fromIO(() => Logger.log(`Persisted status for Workflow ${workflow.id}`))),
      TE.map(() => undefined)
    )
  }
}
