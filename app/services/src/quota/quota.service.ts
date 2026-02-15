import {QuotaIdentifier, QuotaScope} from "@domain"
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
import {sequenceT} from "fp-ts/lib/Apply"

import {USER_REPOSITORY_TOKEN, UserRepository} from "../user/interfaces"

@Injectable()
export class QuotaService {
  constructor(
    @Inject(QUOTA_REPOSITORY_TOKEN) private readonly quotaRepo: QuotaRepository,
    @Inject(GROUP_REPOSITORY_TOKEN) private readonly groupRepo: GroupRepository,
    @Inject(SPACE_REPOSITORY_TOKEN) private readonly spaceRepo: SpaceRepository,
    @Inject(WORKFLOW_TEMPLATE_REPOSITORY_TOKEN) private readonly workflowTemplateRepo: WorkflowTemplateRepository,
    @Inject(WORKFLOW_REPOSITORY_TOKEN) private readonly workflowRepo: WorkflowRepository,
    @Inject(GROUP_MEMBERSHIP_REPOSITORY_TOKEN) private readonly groupMembershipRepo: GroupMembershipRepository,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepo: UserRepository
  ) {}

  /**
   * Checks if the quota for a specific global metric is satisfied.
   * Returns true if usage < limit, or if no quota is defined.
   * Returns false if usage >= limit.
   *
   * **Note:** This method is not race-condition safe. It performs a best-effort
   * check to limit usage. The actual usage may change between reading the quota
   * and performing the operation.
   */
  isGlobalQuotaAvailable(identifier: QuotaIdentifier & {scope: "GLOBAL"}): TE.TaskEither<UnknownError, boolean> {
    return this.isQuotaAvailable(identifier, this.getGlobalUsage(identifier))
  }

  /**
   * Checks if the quota for a specific non-global metric is satisfied.
   * Returns true if usage < limit, or if no quota is defined.
   * Returns false if usage >= limit.
   *
   * **Note:** This method is not race-condition safe. It performs a best-effort
   * check to limit usage. The actual usage may change between reading the quota
   * and performing the operation.
   */
  isTargetedQuotaAvailable(
    identifier: QuotaIdentifier & {scope: Exclude<QuotaScope, "GLOBAL">},
    targetId: string
  ): TE.TaskEither<UnknownError, boolean> {
    return this.isQuotaAvailable(identifier, this.getTargetedUsage(identifier, targetId))
  }

  private isQuotaAvailable(
    identifier: QuotaIdentifier,
    currentUsage: TE.TaskEither<UnknownError, number>
  ): TE.TaskEither<UnknownError, boolean> {
    return pipe(
      this.quotaRepo.getQuota(identifier),
      TE.fold(
        error => {
          if (error === "quota_not_found") return TE.right(true) // No quota = unlimited
          return TE.left("unknown_error")
        },
        quota => {
          return pipe(
            currentUsage,
            TE.map(usage => usage < quota.limit)
          )
        }
      )
    )
  }

  private getGlobalUsage(identifier: QuotaIdentifier & {scope: "GLOBAL"}): TE.TaskEither<UnknownError, number> {
    switch (identifier.metric) {
      case "MAX_GROUPS":
        return this.groupRepo.countGroups()
      case "MAX_SPACES":
        return this.spaceRepo.countSpaces()
    }
  }

  private getTargetedUsage(
    identifier: QuotaIdentifier & {scope: Exclude<QuotaScope, "GLOBAL">},
    targetId: string
  ): TE.TaskEither<UnknownError, number> {
    switch (identifier.metric) {
      case "MAX_TEMPLATES":
        return this.workflowTemplateRepo.countWorkflowTemplatesBySpaceId(targetId)
      case "MAX_ENTITIES_PER_GROUP":
        return pipe(
          sequenceT(TE.ApplyPar)(
            this.groupMembershipRepo.countUserMembersByGroupId(targetId),
            this.groupMembershipRepo.countAgentMembersByGroupId(targetId)
          ),
          TE.map(([users, agents]) => users + agents)
        )
      case "MAX_CONCURRENT_WORKFLOWS":
        return this.workflowRepo.countActiveWorkflowsByTemplateId(targetId)
      case "MAX_ROLES_PER_USER":
        return pipe(
          this.userRepo.getUserById(targetId),
          TE.map(user => user.roles.length),
          TE.orElse(() => TE.right(0)) // If user not found (e.g. creating new user), assume 0 roles
        )
    }
  }
}
