import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError} from "@services/error"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import * as O from "fp-ts/Option"
import {logSuccess, isUUIDv7} from "@utils"
import {
  WorkflowTemplate,
  WorkflowTemplateFactory,
  WorkflowTemplateValidationError,
  WorkflowStatus,
  markTemplateForDeprecation,
  markTemplateAsDeprecated,
  WorkflowTemplateDeprecationError
} from "@domain"
import {QuotaService} from "@services/quota/quota.service"
import {
  WorkflowTemplateRepository,
  WORKFLOW_TEMPLATE_REPOSITORY_TOKEN,
  CreateWorkflowTemplateRequest,
  CreateWorkflowTemplateError,
  UpdateWorkflowTemplateRequest,
  WorkflowTemplateUpdateError,
  WorkflowTemplateGetError,
  WorkflowTemplateDeprecateError,
  DeprecateWorkflowTemplateRequest,
  ListWorkflowTemplatesRequest,
  ListWorkflowTemplatesRequestRepo,
  ListWorkflowTemplatesResponse,
  WorkflowTemplateGetActiveError
} from "./interfaces"
import {
  WorkflowRepository,
  WORKFLOW_REPOSITORY_TOKEN,
  WorkflowUpdateError,
  WorkflowGetError
} from "../workflow/interfaces"
import {UnknownError} from "@services/error"
import {Versioned} from "@domain"
import {validateUserEntity} from "@services/shared/types"

@Injectable()
export class WorkflowTemplateService {
  constructor(
    @Inject(WORKFLOW_TEMPLATE_REPOSITORY_TOKEN)
    private readonly workflowTemplateRepository: WorkflowTemplateRepository,
    @Inject(WORKFLOW_REPOSITORY_TOKEN)
    private readonly workflowRepository: WorkflowRepository,
    private readonly quotaService: QuotaService
  ) {}

  createWorkflowTemplate(
    request: CreateWorkflowTemplateRequest
  ): TaskEither<CreateWorkflowTemplateError | AuthorizationError, Versioned<WorkflowTemplate>> {
    const checkQuota = () =>
      pipe(
        this.quotaService.isQuotaAvailable(
          {type: "Space", identifier: request.workflowTemplateData.spaceId},
          "MAX_WORKFLOW_TEMPLATES_PER_SPACE",
          1
        ),
        TE.mapLeft(() => "quota_check_error" as const),
        TE.chainW(isAvailable => (isAvailable ? TE.right(undefined) : TE.left("quota_exceeded" as const)))
      )

    return pipe(
      validateUserEntity(request.requestor),
      TE.fromEither,
      TE.chainW(() => checkQuota()),
      TE.chainEitherKW(() =>
        WorkflowTemplateFactory.newWorkflowTemplate({
          name: request.workflowTemplateData.name,
          description: request.workflowTemplateData.description,
          approvalRule: request.workflowTemplateData.approvalRule,
          actions: request.workflowTemplateData.actions || [],
          defaultExpiresInHours: request.workflowTemplateData.defaultExpiresInHours,
          spaceId: request.workflowTemplateData.spaceId
        })
      ),
      TE.chainW(workflowTemplate => this.workflowTemplateRepository.createWorkflowTemplate(workflowTemplate)),
      logSuccess("Workflow template created", "WorkflowTemplateService", t => ({id: t.id}))
    )
  }

  getWorkflowTemplateByIdentifier(
    templateIdentifier: string
  ): TaskEither<WorkflowTemplateGetError | WorkflowTemplateGetActiveError, Versioned<WorkflowTemplate>> {
    if (isUUIDv7(templateIdentifier)) {
      return pipe(
        this.workflowTemplateRepository.getWorkflowTemplateById(templateIdentifier),
        logSuccess("Workflow template retrieved by id", "WorkflowTemplateService", t => ({id: t.id}))
      )
    }

    return pipe(
      this.workflowTemplateRepository.getActiveWorkflowTemplateByName(templateIdentifier),
      TE.altW(() =>
        pipe(
          this.workflowTemplateRepository.getMostRecentNonActiveWorkflowTemplateByName(templateIdentifier),
          TE.chainW(maybeTemplate =>
            pipe(
              maybeTemplate,
              O.fold(
                () => TE.left("workflow_template_not_found" as const),
                template => TE.right(template)
              )
            )
          )
        )
      ),
      logSuccess("Workflow template retrieved by name", "WorkflowTemplateService", t => ({id: t.id}))
    )
  }

  updateWorkflowTemplate(
    request: UpdateWorkflowTemplateRequest
  ): TaskEither<
    | WorkflowTemplateGetError
    | WorkflowTemplateGetActiveError
    | WorkflowTemplateUpdateError
    | WorkflowTemplateDeprecationError
    | CreateWorkflowTemplateError
    | AuthorizationError,
    Versioned<WorkflowTemplate>
  > {
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))
    const validateAttributes = () =>
      TE.fromEither(WorkflowTemplateFactory.validateAttributes(request.workflowTemplateData))

    return pipe(
      TE.Do,
      TE.bindW("requestor", () => validateRequestor()),
      TE.bindW("validatedAttributes", validateAttributes),
      TE.bindW("activeTemplate", () =>
        isUUIDv7(request.templateName)
          ? this.workflowTemplateRepository.getWorkflowTemplateById(request.templateName)
          : this.workflowTemplateRepository.getActiveWorkflowTemplateByName(request.templateName)
      ),
      // Fail-fast if the active template has been updated since the last read done by the caller
      TE.chainFirstW(({activeTemplate}) => {
        if (activeTemplate.occ !== request.occVersion) return TE.left("concurrency_error" as const)
        return TE.right(undefined)
      }),
      // Simulate the deprecation in the domain
      TE.bindW("deprecatedVersion", ({activeTemplate}) => {
        return TE.fromEither(markTemplateForDeprecation(activeTemplate, request.cancelWorkflows ?? false))
      }),
      TE.bindW("deprecatedVersionWithOcc", ({deprecatedVersion, activeTemplate}) => {
        return TE.right({
          ...deprecatedVersion,
          // Re-inject the expected OCC that must be validated during the actual update
          occ: activeTemplate.occ
        })
      }),
      // Generate the new active template that will replace the existing one
      TE.bindW("newVersion", ({activeTemplate, validatedAttributes}) =>
        TE.fromEither(
          WorkflowTemplateFactory.newWorkflowTemplate({
            ...activeTemplate,
            ...validatedAttributes,
            version: activeTemplate.version + 1
          })
        )
      ),
      // Atomically update the existing template and create the new one
      TE.chainW(({deprecatedVersionWithOcc, newVersion}) =>
        this.workflowTemplateRepository.atomicUpdateAndCreate({
          existingTemplate: deprecatedVersionWithOcc,
          newTemplate: newVersion
        })
      ),
      logSuccess("Workflow template updated", "WorkflowTemplateService", t => ({id: t.id}))
    )
  }

  /**
   * Cancels all active workflows associated with the given template, then marks the template
   * itself as deprecated.
   *
   * Workflow cancellation is performed in a retry loop: after each cancellation pass,
   * the remaining active workflow count is checked. If workflows are still active and
   * more attempts are available, the loop recurses. This guards against concurrent
   * workflow creation racing with the cancellation.
   *
   * Once all workflows are cancelled, the template is fetched, transitioned to the
   * `deprecated` state via the domain function, and persisted with its current OCC
   * to enforce optimistic concurrency.
   *
   * @param templateId - UUID of the workflow template to deprecate.
   * @param maxAttempts - Maximum number of cancellation passes before giving up (default: 2).
   * @returns `TaskEither` resolving to `void` on success, or one of the typed error
   *          variants on failure (including `"max_attempts_reach_for_cancelling_workflows"`
   *          if active workflows persist after all attempts).
   */
  cancelWorkflowsAndDeprecateTemplate(
    templateId: string,
    maxAttempts = 2
  ): TaskEither<
    | "max_attempts_reach_for_cancelling_workflows"
    | WorkflowTemplateGetError
    | WorkflowTemplateDeprecateError
    | WorkflowGetError
    | WorkflowUpdateError
    | UnknownError,
    void
  > {
    /**
     * Recursive helper that runs one cancellation pass and retries if active workflows
     * remain, up to `maxAttempts` total iterations.
     */
    const cancelWorkflowsLoop = (
      attempt: number
    ): TaskEither<
      | "max_attempts_reach_for_cancelling_workflows"
      | WorkflowTemplateDeprecateError
      | WorkflowGetError
      | WorkflowUpdateError,
      void
    > => {
      return pipe(
        this.cancelWorkflows(templateId),
        TE.chainW(remainingWorkflows => {
          if (remainingWorkflows > 0) {
            if (attempt + 1 >= maxAttempts) return TE.left("max_attempts_reach_for_cancelling_workflows" as const)

            return cancelWorkflowsLoop(attempt + 1)
          }
          return TE.right(undefined)
        })
      )
    }

    return pipe(
      cancelWorkflowsLoop(0),
      TE.chainW(() => this.workflowTemplateRepository.getWorkflowTemplateById(templateId)),
      TE.chainW(template =>
        pipe(
          markTemplateAsDeprecated(template),
          TE.fromEither,
          TE.map(deprecatedTemplate => ({...deprecatedTemplate, occ: template.occ}))
        )
      ),
      TE.chainW(versionedDeprecatedTemplate =>
        this.workflowTemplateRepository.updateWorkflowTemplate(versionedDeprecatedTemplate)
      ),
      TE.map(() => undefined)
    )
  }

  /**
   * Fetches all non-terminal workflows for the given template and cancels each one
   * individually using a concurrent-safe update. After the cancellation pass, the
   * active workflow count is re-fetched and returned so the caller can decide whether
   * another pass is needed.
   *
   * @returns `TaskEither` resolving to the number of still-active workflows after
   *          the cancellation attempt.
   *
   * @remarks Known inefficiencies:
   * - Workflows are cancelled one by one; a batch update would be more efficient.
   * - Active workflows are listed twice per pass (before and after cancellation).
   */
  private cancelWorkflows(
    templateId: string
  ): TaskEither<
    | "max_attempts_reach_for_cancelling_workflows"
    | WorkflowTemplateDeprecateError
    | WorkflowGetError
    | WorkflowUpdateError,
    number
  > {
    const getActiveWorkflowsForTemplate = () =>
      this.workflowRepository.listWorkflows({
        include: {occ: true},
        filters: {includeOnlyNonTerminalState: true, templateId}
      })

    // This function is highly inefficient. A few improvements:
    // - Batch update the workflows
    // - Avoid fetching the active workflows twice in a loop is needed
    return pipe(
      TE.Do,
      TE.bindW("activeWorkflows", getActiveWorkflowsForTemplate),
      TE.chainW(({activeWorkflows}) =>
        pipe(
          TE.sequenceArray(
            activeWorkflows.workflows.map(workflow =>
              this.workflowRepository.updateWorkflowConcurrentSafe(workflow.id, workflow.occ, {
                status: WorkflowStatus.CANCELED,
                updatedAt: new Date()
              })
            )
          )
        )
      ),
      TE.chainW(() => getActiveWorkflowsForTemplate()),
      TE.map(workflows => workflows.pagination.total)
    )
  }

  deprecateWorkflowTemplate(
    request: DeprecateWorkflowTemplateRequest
  ): TaskEither<
    WorkflowTemplateGetError | WorkflowTemplateGetActiveError | WorkflowTemplateDeprecateError | AuthorizationError,
    Versioned<WorkflowTemplate>
  > {
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))
    return pipe(
      TE.Do,
      TE.bindW("requestor", () => validateRequestor()),
      TE.bindW("activeTemplate", () =>
        isUUIDv7(request.templateName)
          ? this.workflowTemplateRepository.getWorkflowTemplateById(request.templateName)
          : this.workflowTemplateRepository.getActiveWorkflowTemplateByName(request.templateName)
      ),
      TE.bindW("deprecatedVersion", ({activeTemplate}) => {
        return TE.fromEither(markTemplateForDeprecation(activeTemplate, request.cancelWorkflows ?? false))
      }),
      TE.bindW("deprecatedVersionWithOcc", ({deprecatedVersion, activeTemplate}) => {
        return TE.right({
          ...deprecatedVersion,
          occ: activeTemplate.occ
        })
      }),
      TE.chainW(({deprecatedVersionWithOcc}) =>
        this.workflowTemplateRepository.updateWorkflowTemplate(deprecatedVersionWithOcc)
      ),
      logSuccess("Workflow template deprecated", "WorkflowTemplateService", t => ({id: t.id}))
    )
  }

  listWorkflowTemplates(
    request: ListWorkflowTemplatesRequest
  ): TaskEither<WorkflowTemplateValidationError | UnknownError | AuthorizationError, ListWorkflowTemplatesResponse> {
    const filters = request.filters
      ? {
          spaceId:
            request.filters.spaceIdentifier && isUUIDv7(request.filters.spaceIdentifier)
              ? request.filters.spaceIdentifier
              : undefined,
          spaceName:
            request.filters.spaceIdentifier && !isUUIDv7(request.filters.spaceIdentifier)
              ? request.filters.spaceIdentifier
              : undefined,
          status: request.filters.status
        }
      : undefined

    const repoRequest: ListWorkflowTemplatesRequestRepo = {
      ...request,
      searchMode: request.searchMode,
      sort: request.sort,
      filters
    }

    return pipe(
      validateUserEntity(request.requestor),
      TE.fromEither,
      TE.chainW(() => this.workflowTemplateRepository.listWorkflowTemplates(repoRequest)),
      logSuccess("Workflow templates listed", "WorkflowTemplateService", r => ({count: r.pagination.total}))
    )
  }
}
