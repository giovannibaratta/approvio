import {QuotaMetric, QuotaScope} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {QuotaRepository, QUOTA_REPOSITORY_TOKEN} from "./interfaces"
import {GROUP_REPOSITORY_TOKEN, GroupRepository} from "../group/interfaces"
import {SPACE_REPOSITORY_TOKEN, SpaceRepository} from "../space/interfaces"
import {WORKFLOW_TEMPLATE_REPOSITORY_TOKEN, WorkflowTemplateRepository} from "../workflow-template/interfaces"
import {WORKFLOW_REPOSITORY_TOKEN, WorkflowRepository} from "../workflow/interfaces"
import {GROUP_MEMBERSHIP_REPOSITORY_TOKEN, GroupMembershipRepository} from "../group-membership/interfaces"
import * as TE from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {UnknownError} from "@services/error"
import {QuotaCheckRequest} from "./quota-check-request"

@Injectable()
export class QuotaService {
  constructor(
    @Inject(QUOTA_REPOSITORY_TOKEN) private readonly quotaRepo: QuotaRepository,
    @Inject(GROUP_REPOSITORY_TOKEN) private readonly groupRepo: GroupRepository,
    @Inject(SPACE_REPOSITORY_TOKEN) private readonly spaceRepo: SpaceRepository,
    @Inject(WORKFLOW_TEMPLATE_REPOSITORY_TOKEN) private readonly workflowTemplateRepo: WorkflowTemplateRepository,
    @Inject(WORKFLOW_REPOSITORY_TOKEN) private readonly workflowRepo: WorkflowRepository,
    @Inject(GROUP_MEMBERSHIP_REPOSITORY_TOKEN) private readonly groupMembershipRepo: GroupMembershipRepository
  ) {}

  /**
   * Checks if the quota for a specific metric and target is satisfied.
   * Returns true if usage < limit, or if no quota is defined.
   * Returns false if usage >= limit.
   */
  checkQuota(request: QuotaCheckRequest): TE.TaskEither<UnknownError, boolean> {
    const scope = this.getScopeForMetric(request.metric)

    return pipe(
      this.quotaRepo.getQuota(scope, request.metric),
      TE.fold(
        error => {
          if (error === "quota_not_found") return TE.right(true) // No quota = unlimited
          return TE.left("unknown_error" as UnknownError)
        },
        quota => {
          return pipe(
            this.getCurrentUsage(request),
            TE.map(usage => usage < quota.limit)
          )
        }
      )
    )
  }

  private getScopeForMetric(metric: QuotaMetric): QuotaScope {
    switch (metric) {
      case "MAX_GROUPS":
        return "GLOBAL"
      case "MAX_SPACES":
        return "GLOBAL"
      case "MAX_TEMPLATES":
        return "SPACE"
      case "MAX_USERS":
        return "GROUP"
      case "MAX_CONCURRENT_WORKFLOWS":
        return "TEMPLATE"
      case "MAX_ROLES":
        return "USER"
    }
  }

  private getCurrentUsage(request: QuotaCheckRequest): TE.TaskEither<UnknownError, number> {
    switch (request.metric) {
      case "MAX_GROUPS":
        return this.groupRepo.countGroups()
      case "MAX_SPACES":
        return this.spaceRepo.countSpaces()
      case "MAX_TEMPLATES":
        return this.workflowTemplateRepo.countWorkflowTemplatesBySpaceId(request.targetId)
      case "MAX_USERS":
        return this.groupMembershipRepo.countUserMembersByGroupId(request.targetId)
      case "MAX_CONCURRENT_WORKFLOWS":
        return this.workflowRepo.countActiveWorkflowsByTemplateId(request.targetId)
      case "MAX_ROLES":
        return TE.right(0)
    }
  }
}
