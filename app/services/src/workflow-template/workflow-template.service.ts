import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError} from "@services/error"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import * as O from "fp-ts/Option"
import {
  WorkflowTemplate,
  WorkflowTemplateFactory,
  WorkflowTemplateValidationError,
  WorkflowStatus,
  markTemplateForDeprecation,
  markTemplateAsDeprecated,
  WorkflowTemplateDeprecationError
} from "@domain"
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
  ListWorkflowTemplatesResponse
} from "./interfaces"
import {
  WorkflowRepository,
  WORKFLOW_REPOSITORY_TOKEN,
  WorkflowUpdateError,
  WorkflowGetError
} from "../workflow/interfaces"
import {UnknownError} from "@services/error"
import {Versioned} from "@services/shared/utils"
import * as E from "fp-ts/Either"
import {validateUserEntity} from "@services/shared/types"

@Injectable()
export class WorkflowTemplateService {
  constructor(
    @Inject(WORKFLOW_TEMPLATE_REPOSITORY_TOKEN)
    private readonly workflowTemplateRepository: WorkflowTemplateRepository,
    @Inject(WORKFLOW_REPOSITORY_TOKEN)
    private readonly workflowRepository: WorkflowRepository
  ) {}

  createWorkflowTemplate(
    request: CreateWorkflowTemplateRequest
  ): TaskEither<CreateWorkflowTemplateError | AuthorizationError, WorkflowTemplate> {
    return pipe(
      validateUserEntity(request.requestor),
      E.chainW(() =>
        WorkflowTemplateFactory.newWorkflowTemplate({
          name: request.workflowTemplateData.name,
          description: request.workflowTemplateData.description,
          approvalRule: request.workflowTemplateData.approvalRule,
          actions: request.workflowTemplateData.actions || [],
          defaultExpiresInHours: request.workflowTemplateData.defaultExpiresInHours
        })
      ),
      TE.fromEither,
      TE.chainW(workflowTemplate => this.workflowTemplateRepository.createWorkflowTemplate(workflowTemplate))
    )
  }

  getWorkflowTemplateById(templateId: string): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>> {
    return this.workflowTemplateRepository.getWorkflowTemplateById(templateId)
  }

  getLatestWorkflowTemplateByName(
    templateName: string
  ): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>> {
    return this.workflowTemplateRepository.getWorkflowTemplateByNameAndVersion(templateName, "latest")
  }

  updateWorkflowTemplate(
    request: UpdateWorkflowTemplateRequest
  ): TaskEither<
    | "workflow_template_most_recent_non_active_invalid_status"
    | WorkflowTemplateUpdateError
    | WorkflowTemplateDeprecationError
    | CreateWorkflowTemplateError
    | AuthorizationError,
    WorkflowTemplate
  > {
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))
    const validateAttributes = () =>
      TE.fromEither(WorkflowTemplateFactory.validateAttributes(request.workflowTemplateData))

    return pipe(
      TE.Do,
      TE.bindW("requestor", () => validateRequestor()),
      TE.bindW("validatedAttributes", validateAttributes),
      TE.bindW("latestTemplate", () => this.getLatestWorkflowTemplateByName(request.templateName)),
      TE.bindW("mostRecentNonActive", () =>
        this.workflowTemplateRepository.getMostRecentNonActiveWorkflowTemplateByName(request.templateName)
      ),
      TE.bindW("deprecatedVersion", ({latestTemplate, mostRecentNonActive}) => {
        const nextVersion = pipe(
          mostRecentNonActive,
          O.fold(
            () => E.right(1),
            template => {
              if (template.version === "latest")
                return E.left("workflow_template_most_recent_non_active_invalid_status" as const)
              return E.right(template.version + 1)
            }
          )
        )

        if (E.isLeft(nextVersion)) return TE.left(nextVersion.left)

        return TE.fromEither(
          markTemplateForDeprecation(latestTemplate, nextVersion.right, request.cancelWorkflows ?? false)
        )
      }),
      TE.bindW("deprecatedVersionWithOcc", ({deprecatedVersion, latestTemplate}) => {
        return TE.right({
          ...deprecatedVersion,
          occ: latestTemplate.occ
        })
      }),
      TE.bindW("newVersion", ({latestTemplate, validatedAttributes}) =>
        TE.fromEither(WorkflowTemplateFactory.newWorkflowTemplate({...latestTemplate, ...validatedAttributes}))
      ),
      TE.chainW(({deprecatedVersionWithOcc, newVersion}) =>
        this.workflowTemplateRepository.atomicUpdateAndCreate({
          existingTemplate: deprecatedVersionWithOcc,
          newTemplate: newVersion
        })
      )
    )
  }

  cancelWorkflowsAndDeprecateTemplate(
    templateId: string,
    maxAttempts = 2
  ): TaskEither<
    | "max_attempts_reach_for_cancelling_workflows"
    | WorkflowTemplateDeprecateError
    | WorkflowGetError
    | WorkflowUpdateError
    | UnknownError,
    void
  > {
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
            if (attempt + 1 >= maxAttempts) {
              return TE.left("max_attempts_reach_for_cancelling_workflows" as const)
            }
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
    "workflow_template_most_recent_non_active_invalid_status" | WorkflowTemplateDeprecateError | AuthorizationError,
    Versioned<WorkflowTemplate>
  > {
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))
    return pipe(
      TE.Do,
      TE.bindW("requestor", () => validateRequestor()),
      TE.bindW("latestTemplate", () => this.getLatestWorkflowTemplateByName(request.templateName)),
      TE.bindW("mostRecentNonActive", () =>
        this.workflowTemplateRepository.getMostRecentNonActiveWorkflowTemplateByName(request.templateName)
      ),
      TE.bindW("deprecatedVersion", ({latestTemplate, mostRecentNonActive}) => {
        const nextVersion = pipe(
          mostRecentNonActive,
          O.fold(
            () => E.right(1),
            template => {
              if (template.version === "latest")
                return E.left("workflow_template_most_recent_non_active_invalid_status" as const)
              return E.right(template.version + 1)
            }
          )
        )

        if (E.isLeft(nextVersion)) return TE.left(nextVersion.left)

        return TE.fromEither(
          markTemplateForDeprecation(latestTemplate, nextVersion.right, request.cancelWorkflows ?? false)
        )
      }),
      TE.bindW("deprecatedVersionWithOcc", ({deprecatedVersion, latestTemplate}) => {
        return TE.right({
          ...deprecatedVersion,
          occ: latestTemplate.occ
        })
      }),
      TE.chainW(({deprecatedVersionWithOcc}) =>
        this.workflowTemplateRepository.updateWorkflowTemplate(deprecatedVersionWithOcc)
      )
    )
  }

  listWorkflowTemplates(
    request: ListWorkflowTemplatesRequest
  ): TaskEither<WorkflowTemplateValidationError | UnknownError | AuthorizationError, ListWorkflowTemplatesResponse> {
    return pipe(
      validateUserEntity(request.requestor),
      TE.fromEither,
      TE.chainW(() => this.workflowTemplateRepository.listWorkflowTemplates(request))
    )
  }
}
