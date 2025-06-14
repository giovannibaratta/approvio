import {Inject, Injectable} from "@nestjs/common"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {WorkflowTemplate, WorkflowTemplateFactory, WorkflowTemplateValidationError} from "@domain"
import {
  WorkflowTemplateRepository,
  WORKFLOW_TEMPLATE_REPOSITORY_TOKEN,
  CreateWorkflowTemplateRequest,
  CreateWorkflowTemplateError,
  UpdateWorkflowTemplateRequest,
  WorkflowTemplateUpdateError,
  WorkflowTemplateGetError,
  WorkflowTemplateDeleteError,
  WorkflowTemplateUpdateDataRepo,
  ListWorkflowTemplatesRequest,
  ListWorkflowTemplatesResponse
} from "./interfaces"
import {UnknownError} from "@services/error"
import {Versioned} from "@services/shared/utils"

@Injectable()
export class WorkflowTemplateService {
  constructor(
    @Inject(WORKFLOW_TEMPLATE_REPOSITORY_TOKEN)
    private readonly workflowTemplateRepository: WorkflowTemplateRepository
  ) {}

  createWorkflowTemplate(
    request: CreateWorkflowTemplateRequest
  ): TaskEither<CreateWorkflowTemplateError, WorkflowTemplate> {
    return pipe(
      WorkflowTemplateFactory.newWorkflowTemplate({
        name: request.workflowTemplateData.name,
        description: request.workflowTemplateData.description,
        approvalRule: request.workflowTemplateData.approvalRule,
        actions: request.workflowTemplateData.actions || [],
        defaultExpiresInHours: request.workflowTemplateData.defaultExpiresInHours
      }),
      TE.fromEither,
      TE.chain(workflowTemplate => this.workflowTemplateRepository.createWorkflowTemplate(workflowTemplate))
    )
  }

  getWorkflowTemplateById(templateId: string): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>> {
    return this.workflowTemplateRepository.getWorkflowTemplateById(templateId)
  }

  updateWorkflowTemplate(
    request: UpdateWorkflowTemplateRequest
  ): TaskEither<WorkflowTemplateUpdateError, Versioned<WorkflowTemplate>> {
    const validateAttributes = () =>
      TE.fromEither(WorkflowTemplateFactory.validateAttributes(request.workflowTemplateData))

    const updateData: WorkflowTemplateUpdateDataRepo = {
      ...request.workflowTemplateData,
      updatedAt: new Date()
    }

    const persist = () =>
      this.workflowTemplateRepository.updateWorkflowTemplate(request.templateId, updateData, request.occCheck)

    return pipe(validateAttributes(), TE.chain(persist))
  }

  deleteWorkflowTemplate(templateId: string): TaskEither<WorkflowTemplateDeleteError, void> {
    return this.workflowTemplateRepository.deleteWorkflowTemplate(templateId)
  }

  listWorkflowTemplates(
    request: ListWorkflowTemplatesRequest
  ): TaskEither<WorkflowTemplateValidationError | UnknownError, ListWorkflowTemplatesResponse> {
    return this.workflowTemplateRepository.listWorkflowTemplates(request)
  }
}
