import {
  QuotaFactory,
  Versioned,
  AuthenticatedEntity,
  OrgRole,
  User,
  QuotaIdentifierFactory,
  Quota,
  SupportedQuotaType,
  Node,
  isQuotaTypeApplicableTo
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {
  QuotaRepository,
  QUOTA_REPOSITORY_TOKEN,
  QuotaGetError,
  QuotaCreateError,
  QuotaUpdateError,
  QuotaListError,
  QuotaDeleteError,
  ListQuotasFilter,
  ListQuotasResult,
  QuotaCheckError,
  QuotaUsageError
} from "./interfaces"
import {GROUP_REPOSITORY_TOKEN, GroupRepository} from "../group/interfaces"
import {SPACE_REPOSITORY_TOKEN, SpaceRepository} from "../space/interfaces"
import {WORKFLOW_TEMPLATE_REPOSITORY_TOKEN, WorkflowTemplateRepository} from "../workflow-template/interfaces"
import {WORKFLOW_REPOSITORY_TOKEN, WorkflowRepository} from "../workflow/interfaces"
import {GROUP_MEMBERSHIP_REPOSITORY_TOKEN, GroupMembershipRepository} from "../group-membership/interfaces"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {AuthorizationError} from "@services/error"
import {sequenceT} from "fp-ts/Apply"
import {validateUserEntity} from "@services/shared/types"
import {HierarchyService} from "../hierarchy/hierarchy.service"
import {USER_REPOSITORY_TOKEN, UserRepository} from "../user/interfaces"
import {VOTE_REPOSITORY_TOKEN, VoteRepository} from "../vote/interfaces"

@Injectable()
export class QuotaService {
  constructor(
    @Inject(QUOTA_REPOSITORY_TOKEN) private readonly quotaRepo: QuotaRepository,
    @Inject(GROUP_REPOSITORY_TOKEN) private readonly groupRepo: GroupRepository,
    @Inject(SPACE_REPOSITORY_TOKEN) private readonly spaceRepo: SpaceRepository,
    @Inject(WORKFLOW_TEMPLATE_REPOSITORY_TOKEN) private readonly workflowTemplateRepo: WorkflowTemplateRepository,
    @Inject(WORKFLOW_REPOSITORY_TOKEN) private readonly workflowRepo: WorkflowRepository,
    @Inject(GROUP_MEMBERSHIP_REPOSITORY_TOKEN) private readonly groupMembershipRepo: GroupMembershipRepository,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepo: UserRepository,
    @Inject(VOTE_REPOSITORY_TOKEN) private readonly voteRepo: VoteRepository,
    private readonly hierarchyService: HierarchyService
  ) {}

  /**
   * Checks if the quota for a specific non-org quotaType is satisfied.
   * It attempts to fetch a resource-specific quota first. If not found, it checks if the same quota
   * is defined at the parent level up to all the hierarchy.
   * If no quota exists, returns true (unlimited).
   *
   * **Note:** This method is not race-condition safe. It performs a best-effort
   * check to limit usage. The actual usage may change between reading the quota
   * and performing the operation.
   */

  private getQuota(
    targetNode: Node,
    quotaType: SupportedQuotaType
  ): TE.TaskEither<QuotaGetError, Versioned<Quota> | undefined> {
    return pipe(
      this.hierarchyService.getParents(targetNode),
      // Build the entire chain for which a quota could be potentially returned
      TE.map(parents => [targetNode, ...parents]),
      TE.mapLeft(() => "quota_unknown_error" as const),
      // Starting from the most specific node, search for a quota at each level
      // up to the root (Orgs)
      TE.chain(nodes => {
        return nodes.reduce<TE.TaskEither<QuotaGetError, Versioned<Quota> | undefined>>(
          (acc, currentNode) =>
            pipe(
              acc,
              TE.chain(foundQuota => {
                if (foundQuota) return TE.right(foundQuota)
                return pipe(
                  QuotaIdentifierFactory.fromNodeAndQuota(currentNode, quotaType),
                  TE.fromEither,
                  TE.mapLeft(() => "quota_unknown_error" as const),
                  TE.chain(identifier =>
                    pipe(
                      this.quotaRepo.getQuota(identifier),
                      TE.orElse(error => (error === "quota_not_found" ? TE.right(undefined) : TE.left(error)))
                    )
                  )
                )
              })
            ),
          TE.right(undefined)
        )
      })
    )
  }

  /**
   * Evaluates whether a specific amount of usage can be added for a specific quota type
   * without exceeding the defined limit for the given target node.
   *
   * The method performs the following steps:
   * 1. Validates if the quota type is applicable to the target node's type.
   * 2. Searches for a quota definition starting from the target node and moving up the hierarchy
   *    (using `getQuota`).
   * 3. If no quota is defined at any level, usage is considered unlimited (returns `true`).
   * 4. If a quota is found, it calculates the current usage (using `getUsage`) and returns
   *    `true` if the sum of current usage and the requested `amount` is less than or equal
   *    to the quota limit, `false` otherwise.
   *
   * @param targetNode The node where the operation is being performed.
   * @param quotaType The type of quota to check (e.g., MAX_GROUPS, MAX_SPACES).
   * @param amount The extra amount of usage to check against the quota (defaults to 1).
   * @returns A TaskEither resolving to `true` if quota is available, `false` if exceeded,
   *          or a `QuotaCheckError` if the check fails.
   */
  isQuotaAvailable(
    targetNode: Node,
    quotaType: SupportedQuotaType,
    amount: number = 1
  ): TE.TaskEither<QuotaCheckError, boolean> {
    return pipe(
      quotaType,
      TE.fromPredicate(
        m => isQuotaTypeApplicableTo(m, targetNode.type),
        () => "quota_unsupported_quota_type_for_node" as const
      ),
      TE.chainW(m => this.getQuota(targetNode, m)),
      TE.chainW(quota => {
        if (!quota) return TE.right(true)

        return pipe(
          this.getUsage(targetNode, quotaType),
          TE.map(usage => usage + amount <= quota.limit)
        )
      })
    )
  }

  private getUsage(target: Node, quotaType: SupportedQuotaType): TE.TaskEither<QuotaUsageError, number> {
    switch (quotaType) {
      case "MAX_GROUPS":
        // TODO(long-term): Org quotaType do not use target because we don't have multi org support yet
        return this.groupRepo.countGroups()
      case "MAX_SPACES":
        // TODO(long-term): Org quotaType do not use target because we don't have multi org support yet
        return this.spaceRepo.countSpaces()
      case "MAX_WORKFLOW_TEMPLATES_PER_SPACE":
        return this.workflowTemplateRepo.countUniqueWorkflowTemplatesBySpaceId(target.identifier)
      case "MAX_ENTITIES_PER_GROUP":
        return pipe(
          sequenceT(TE.ApplyPar)(
            this.groupMembershipRepo.countUserMembersByGroupId(target.identifier),
            this.groupMembershipRepo.countAgentMembersByGroupId(target.identifier)
          ),
          TE.map(([users, agents]) => users + agents)
        )
      case "MAX_CONCURRENT_WORKFLOWS":
        return this.workflowRepo.countActiveWorkflowsByTemplateId(target.identifier)
      case "MAX_ROLES_PER_USER":
        return pipe(
          this.userRepo.getUserById(target.identifier),
          TE.map(user => user.roles.length)
        )
      case "MAX_VOTES_PER_WORKFLOW":
        return pipe(
          this.voteRepo.getVotesByWorkflowId(target.identifier),
          TE.map(votes => votes.length)
        )
    }
  }

  getQuotaById(id: string): TE.TaskEither<QuotaGetError, Versioned<Quota>> {
    return this.quotaRepo.getQuotaById(id)
  }

  createQuota(
    requestor: AuthenticatedEntity,
    request: CreateQuotaRequest
  ): TE.TaskEither<QuotaCreateError, Versioned<Quota>> {
    return pipe(
      this.checkAdmin(requestor),
      TE.fromEither,
      TE.chain(() =>
        pipe(
          TE.fromEither(
            QuotaFactory.newQuota(
              {node: {type: request.nodeType, identifier: request.nodeIdentifier}, quotaType: request.quotaType},
              request.limit
            )
          ),
          TE.chain(quota => this.quotaRepo.createQuota(quota))
        )
      )
    )
  }

  /** This method is not race-condition safe. */
  updateQuota(
    requestor: AuthenticatedEntity,
    id: string,
    limit?: number
  ): TE.TaskEither<QuotaUpdateError, Versioned<Quota>> {
    return pipe(
      this.checkAdmin(requestor),
      TE.fromEither,
      TE.chain(() =>
        pipe(
          this.quotaRepo.getQuotaById(id),
          TE.chain(existingQuota =>
            pipe(
              TE.fromEither(QuotaFactory.validate({...existingQuota, limit: limit ?? existingQuota.limit})),
              TE.chain(updatedQuota => this.quotaRepo.updateQuota(updatedQuota, existingQuota.occ))
            )
          )
        )
      )
    )
  }

  deleteQuota(requestor: AuthenticatedEntity, id: string): TE.TaskEither<QuotaDeleteError, void> {
    return pipe(
      this.checkAdmin(requestor),
      TE.fromEither,
      TE.chain(() => this.quotaRepo.deleteQuota(id))
    )
  }

  listQuotas(page: number, limit: number, filter?: ListQuotasFilter): TE.TaskEither<QuotaListError, ListQuotasResult> {
    return this.quotaRepo.listQuotas(page, limit, filter)
  }

  private checkAdmin(requestor: AuthenticatedEntity): E.Either<AuthorizationError, User> {
    return pipe(
      validateUserEntity(requestor),
      E.chain(user => (user.orgRole === OrgRole.ADMIN ? E.right(user) : E.left("requestor_not_authorized")))
    )
  }
}

export interface CreateQuotaRequest {
  nodeType: string
  nodeIdentifier: string
  quotaType: string
  limit: number
}
