import {GetAuthenticatedEntity, GetTenantContext} from "@app/auth"
import {Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Put, Query, Res} from "@nestjs/common"
import {logSuccess} from "@utils"
import {
  WorkflowTemplateService,
  CreateWorkflowTemplateRequest,
  UpdateWorkflowTemplateRequest,
  DeprecateWorkflowTemplateRequest
} from "@services"
import {Response} from "express"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {
  createWorkflowTemplateApiToServiceModel,
  updateWorkflowTemplateApiToServiceModel,
  generateErrorResponseForCreateWorkflowTemplate,
  generateErrorResponseForGetWorkflowTemplate,
  generateErrorResponseForUpdateWorkflowTemplate,
  generateErrorResponseForDeprecateWorkflowTemplate,
  generateErrorResponseForListWorkflowTemplates,
  mapWorkflowTemplateToApi,
  mapWorkflowTemplateListToApi,
  mapListWorkflowTemplatesParamsToServiceRequest
} from "./workflow-templates.mappers"
import {
  WorkflowTemplateCreate,
  WorkflowTemplate as WorkflowTemplateApi,
  ListWorkflowTemplates200Response,
  WorkflowTemplateUpdate,
  WorkflowTemplateDeprecate,
  validateListWorkflowTemplatesParams
} from "@approvio/api"
import {AuthenticatedEntity, TenantContext} from "@domain"
import {isLeft} from "fp-ts/Either"
import {ConfigProvider} from "@external/config"
import {createEntityTag, parseEntityTag} from "../etag"

export const WORKFLOW_TEMPLATES_ENDPOINT_ROOT = "workflow-templates"

@Controller(`o/:organizationId/${WORKFLOW_TEMPLATES_ENDPOINT_ROOT}`)
export class WorkflowTemplatesController {
  private readonly etagSecret: string

  constructor(
    private readonly workflowTemplateService: WorkflowTemplateService,
    configProvider: ConfigProvider
  ) {
    this.etagSecret = configProvider.jwtConfig.secret
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWorkflowTemplate(
    @Body() request: WorkflowTemplateCreate,
    @Res({passthrough: true}) response: Response,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @GetTenantContext() context: TenantContext
  ): Promise<WorkflowTemplateApi> {
    const serviceCreateWorkflowTemplate = (req: CreateWorkflowTemplateRequest) =>
      this.workflowTemplateService.createWorkflowTemplate(req)

    const eitherWorkflowTemplate = await pipe(
      {workflowTemplateData: request, requestor, context},
      createWorkflowTemplateApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceCreateWorkflowTemplate),
      TE.map(mapWorkflowTemplateToApi),
      logSuccess("Workflow template created", "WorkflowTemplatesController", t => ({id: t.id}))
    )()

    if (isLeft(eitherWorkflowTemplate))
      throw generateErrorResponseForCreateWorkflowTemplate(
        eitherWorkflowTemplate.left,
        "Failed to create workflow template"
      )

    const workflowTemplate = eitherWorkflowTemplate.right
    // Set Location header
    const location = `${response.req.protocol}://${response.req.headers.host}${response.req.url}/${workflowTemplate.id}`
    response.setHeader("Location", location)

    return workflowTemplate
  }

  @Get()
  async listWorkflowTemplates(
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @GetTenantContext() context: TenantContext,
    @Query() query: Record<string, unknown>
  ): Promise<ListWorkflowTemplates200Response> {
    const eitherWorkflowTemplates = await pipe(
      validateListWorkflowTemplatesParams(query),
      E.chainW(params => mapListWorkflowTemplatesParamsToServiceRequest(params, requestor, context)),
      TE.fromEither,
      TE.chainW(req => this.workflowTemplateService.listWorkflowTemplates(req)),
      TE.map(mapWorkflowTemplateListToApi),
      logSuccess("Workflow templates listed", "WorkflowTemplatesController", r => ({
        count: r.pagination.total
      }))
    )()

    if (isLeft(eitherWorkflowTemplates))
      throw generateErrorResponseForListWorkflowTemplates(
        eitherWorkflowTemplates.left,
        "Failed to list workflow templates"
      )

    return eitherWorkflowTemplates.right
  }

  @Get(":templateIdentifier")
  async getWorkflowTemplate(
    @Param("templateIdentifier") templateIdentifier: string,
    @GetTenantContext() context: TenantContext
  ): Promise<WorkflowTemplateApi> {
    const getWorkflowTemplateService = (identifier: string) =>
      this.workflowTemplateService.getWorkflowTemplateByIdentifier(context, identifier)

    const eitherWorkflowTemplate = await pipe(
      templateIdentifier,
      TE.right,
      TE.chainW(getWorkflowTemplateService),
      TE.map(versioned => mapWorkflowTemplateToApi(versioned)),
      logSuccess("Workflow template retrieved", "WorkflowTemplatesController", t => ({id: t.id}))
    )()

    if (isLeft(eitherWorkflowTemplate))
      throw generateErrorResponseForGetWorkflowTemplate(eitherWorkflowTemplate.left, "Failed to get workflow template")

    return eitherWorkflowTemplate.right
  }

  @Put(":templateIdentifier")
  async updateWorkflowTemplate(
    @Param("templateIdentifier") templateName: string,
    @Body() request: WorkflowTemplateUpdate,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({passthrough: true}) response: Response,
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<WorkflowTemplateApi> {
    const eitherWorkflowTemplate = await pipe(
      parseEntityTag(this.etagSecret, context.organizationId, templateName, ifMatch),
      TE.fromEither,
      TE.chainEitherKW(occVersion =>
        updateWorkflowTemplateApiToServiceModel({
          templateName,
          workflowTemplateData: request,
          requestor,
          context,
          occVersion
        })
      ),
      TE.chainW((req: UpdateWorkflowTemplateRequest) => this.workflowTemplateService.updateWorkflowTemplate(req)),
      logSuccess("Workflow template updated", "WorkflowTemplatesController", t => ({id: t.id})),
      TE.map(template => ({occ: template.occ, body: mapWorkflowTemplateToApi(template)}))
    )()

    if (isLeft(eitherWorkflowTemplate))
      throw generateErrorResponseForUpdateWorkflowTemplate(
        eitherWorkflowTemplate.left,
        "Failed to update workflow template"
      )

    const {occ, body} = eitherWorkflowTemplate.right
    response.setHeader("ETag", createEntityTag(this.etagSecret, context.organizationId, templateName, occ))
    return body
  }

  @Post(":templateIdentifier/deprecate")
  @HttpCode(HttpStatus.OK)
  async deprecateWorkflowTemplate(
    @Param("templateIdentifier") templateName: string,
    @Body() body: WorkflowTemplateDeprecate,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @GetTenantContext() context: TenantContext
  ): Promise<WorkflowTemplateApi> {
    const request: DeprecateWorkflowTemplateRequest = {
      templateName,
      cancelWorkflows: body?.cancelWorkflows || false,
      organizationId: context.organizationId,
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
