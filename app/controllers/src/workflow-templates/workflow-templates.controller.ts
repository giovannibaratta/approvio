import {GetAuthenticatedEntity} from "@app/auth"
import {Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res} from "@nestjs/common"
import {logSuccess} from "@utils"
import {
  WorkflowTemplateService,
  CreateWorkflowTemplateRequest,
  UpdateWorkflowTemplateRequest,
  DeprecateWorkflowTemplateRequest
} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"
import {
  createWorkflowTemplateApiToServiceModel,
  updateWorkflowTemplateApiToServiceModel,
  generateErrorResponseForCreateWorkflowTemplate,
  generateErrorResponseForGetWorkflowTemplate,
  generateErrorResponseForUpdateWorkflowTemplate,
  generateErrorResponseForDeprecateWorkflowTemplate,
  generateErrorResponseForListWorkflowTemplates,
  mapWorkflowTemplateToApi,
  mapWorkflowTemplateListToApi
} from "./workflow-templates.mappers"
import {
  WorkflowTemplateCreate,
  WorkflowTemplate as WorkflowTemplateApi,
  ListWorkflowTemplates200Response,
  WorkflowTemplateUpdate,
  WorkflowTemplateDeprecate
} from "@approvio/api"
import {AuthenticatedEntity} from "@domain"

export const WORKFLOW_TEMPLATES_ENDPOINT_ROOT = "workflow-templates"

@Controller(WORKFLOW_TEMPLATES_ENDPOINT_ROOT)
export class WorkflowTemplatesController {
  constructor(private readonly workflowTemplateService: WorkflowTemplateService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWorkflowTemplate(
    @Body() request: WorkflowTemplateCreate,
    @Res({passthrough: true}) response: Response,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<WorkflowTemplateApi> {
    const serviceCreateWorkflowTemplate = (req: CreateWorkflowTemplateRequest) =>
      this.workflowTemplateService.createWorkflowTemplate(req)

    const eitherWorkflowTemplate = await pipe(
      {workflowTemplateData: request, requestor},
      createWorkflowTemplateApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceCreateWorkflowTemplate),
      TE.map(mapWorkflowTemplateToApi),
      logSuccess("Workflow template created", "WorkflowTemplatesController", t => ({id: t.id}))
    )()

    if (isLeft(eitherWorkflowTemplate)) {
      throw generateErrorResponseForCreateWorkflowTemplate(
        eitherWorkflowTemplate.left,
        "Failed to create workflow template"
      )
    }

    const workflowTemplate = eitherWorkflowTemplate.right
    // Set Location header
    const location = `${response.req.protocol}://${response.req.headers.host}${response.req.url}/${workflowTemplate.id}`
    response.setHeader("Location", location)

    return workflowTemplate
  }

  @Get()
  async listWorkflowTemplates(
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "20",
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<ListWorkflowTemplates200Response> {
    const pageNum = parseInt(page, 10) || 1
    const limitNum = parseInt(limit, 10) || 20

    const request = {
      pagination: {page: pageNum, limit: limitNum},
      requestor
    }

    const eitherWorkflowTemplates = await pipe(
      request,
      TE.right,
      TE.chainW(req => this.workflowTemplateService.listWorkflowTemplates(req)),
      TE.map(mapWorkflowTemplateListToApi),
      logSuccess("Workflow templates listed", "WorkflowTemplatesController", r => ({count: r.pagination.total}))
    )()

    if (isLeft(eitherWorkflowTemplates)) {
      throw generateErrorResponseForListWorkflowTemplates(
        eitherWorkflowTemplates.left,
        "Failed to list workflow templates"
      )
    }

    return eitherWorkflowTemplates.right
  }

  @Get(":templateId")
  async getWorkflowTemplate(@Param("templateId") templateId: string): Promise<WorkflowTemplateApi> {
    const getWorkflowTemplateService = (id: string) => this.workflowTemplateService.getWorkflowTemplateById(id)

    const eitherWorkflowTemplate = await pipe(
      templateId,
      TE.right,
      TE.chainW(getWorkflowTemplateService),
      TE.map(versioned => mapWorkflowTemplateToApi(versioned)),
      logSuccess("Workflow template retrieved", "WorkflowTemplatesController", t => ({id: t.id}))
    )()

    if (isLeft(eitherWorkflowTemplate)) {
      throw generateErrorResponseForGetWorkflowTemplate(eitherWorkflowTemplate.left, "Failed to get workflow template")
    }

    return eitherWorkflowTemplate.right
  }

  @Put(":templateName")
  async updateWorkflowTemplate(
    @Param("templateName") templateName: string,
    @Body() request: WorkflowTemplateUpdate,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<WorkflowTemplateApi> {
    const serviceUpdateWorkflowTemplate = (req: UpdateWorkflowTemplateRequest) =>
      this.workflowTemplateService.updateWorkflowTemplate(req)

    const eitherWorkflowTemplate = await pipe(
      {templateName, workflowTemplateData: request, requestor},
      updateWorkflowTemplateApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceUpdateWorkflowTemplate),
      TE.map(mapWorkflowTemplateToApi),
      logSuccess("Workflow template updated", "WorkflowTemplatesController", t => ({id: t.id}))
    )()

    if (isLeft(eitherWorkflowTemplate))
      throw generateErrorResponseForUpdateWorkflowTemplate(
        eitherWorkflowTemplate.left,
        "Failed to update workflow template"
      )

    return eitherWorkflowTemplate.right
  }

  @Post(":templateName/deprecate")
  @HttpCode(HttpStatus.OK)
  async deprecateWorkflowTemplate(
    @Param("templateName") templateName: string,
    @Body() body: WorkflowTemplateDeprecate,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<WorkflowTemplateApi> {
    const request: DeprecateWorkflowTemplateRequest = {
      templateName,
      cancelWorkflows: body?.cancelWorkflows || false,
      requestor
    }

    const eitherResult = await pipe(
      request,
      TE.right,
      TE.chainW(req => this.workflowTemplateService.deprecateWorkflowTemplate(req)),
      TE.map(mapWorkflowTemplateToApi),
      logSuccess("Workflow template deprecated", "WorkflowTemplatesController", t => ({id: t.id}))
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForDeprecateWorkflowTemplate(
        eitherResult.left,
        "Failed to deprecate workflow template"
      )

    return eitherResult.right
  }
}
