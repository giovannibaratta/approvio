import {GetAuthenticatedUser} from "@app/auth"
import {User} from "@domain"
import {Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res} from "@nestjs/common"
import {WorkflowTemplateService, CreateWorkflowTemplateRequest, UpdateWorkflowTemplateRequest} from "@services"
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
  generateErrorResponseForDeleteWorkflowTemplate,
  generateErrorResponseForListWorkflowTemplates,
  mapWorkflowTemplateToApi,
  mapWorkflowTemplateListToApi
} from "./workflow-templates.mappers"
import {
  WorkflowTemplateCreate,
  WorkflowTemplate as WorkflowTemplateApi,
  ListWorkflowTemplates200Response,
  WorkflowTemplateUpdate
} from "@approvio/api"

export const WORKFLOW_TEMPLATES_ENDPOINT_ROOT = "workflow-templates"

@Controller(WORKFLOW_TEMPLATES_ENDPOINT_ROOT)
export class WorkflowTemplatesController {
  constructor(private readonly workflowTemplateService: WorkflowTemplateService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWorkflowTemplate(
    @Body() request: WorkflowTemplateCreate,
    @Res({passthrough: true}) response: Response,
    @GetAuthenticatedUser() requestor: User
  ): Promise<WorkflowTemplateApi> {
    const serviceCreateWorkflowTemplate = (req: CreateWorkflowTemplateRequest) =>
      this.workflowTemplateService.createWorkflowTemplate(req)

    const eitherWorkflowTemplate = await pipe(
      {workflowTemplateData: request, requestor},
      createWorkflowTemplateApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceCreateWorkflowTemplate),
      TE.map(mapWorkflowTemplateToApi)
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
    @GetAuthenticatedUser() requestor: User
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
      TE.map(mapWorkflowTemplateListToApi)
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
      TE.map(versioned => mapWorkflowTemplateToApi(versioned))
    )()

    if (isLeft(eitherWorkflowTemplate)) {
      throw generateErrorResponseForGetWorkflowTemplate(eitherWorkflowTemplate.left, "Failed to get workflow template")
    }

    return eitherWorkflowTemplate.right
  }

  @Put(":templateId")
  async updateWorkflowTemplate(
    @Param("templateId") templateId: string,
    @Body() request: WorkflowTemplateUpdate,
    @GetAuthenticatedUser() requestor: User
  ): Promise<WorkflowTemplateApi> {
    const serviceUpdateWorkflowTemplate = (req: UpdateWorkflowTemplateRequest) =>
      this.workflowTemplateService.updateWorkflowTemplate(req)

    const eitherWorkflowTemplate = await pipe(
      {templateId, workflowTemplateData: request, requestor},
      updateWorkflowTemplateApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceUpdateWorkflowTemplate),
      TE.map(versioned => mapWorkflowTemplateToApi(versioned))
    )()

    if (isLeft(eitherWorkflowTemplate)) {
      throw generateErrorResponseForUpdateWorkflowTemplate(
        eitherWorkflowTemplate.left,
        "Failed to update workflow template"
      )
    }

    return eitherWorkflowTemplate.right
  }

  @Delete(":templateId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteWorkflowTemplate(@Param("templateId") templateId: string): Promise<void> {
    const eitherResult = await pipe(
      templateId,
      TE.right,
      TE.chainW(id => this.workflowTemplateService.deleteWorkflowTemplate(id))
    )()

    if (isLeft(eitherResult)) {
      throw generateErrorResponseForDeleteWorkflowTemplate(eitherResult.left, "Failed to delete workflow template")
    }
  }
}
