import {Body, Controller, HttpCode, HttpStatus, Post} from "@nestjs/common"
import {GetAuthenticatedEntity} from "@app/auth"
import {AuthenticatedEntity} from "@domain"
import {isLeft} from "fp-ts/Either"
import * as E from "fp-ts/Either"
import {generateErrorResponseForResolveResources, mapToResourceResolveResponse} from "./resources.mappers"
import {ResolveResourcesRequest, ResourcesService} from "@services"
import {ResourceResolveResponse as ApiResourceResolveResponse, validateResourceResolveRequest} from "@approvio/api"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {logSuccess} from "@utils"

@Controller("resources")
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Post("resolve")
  @HttpCode(HttpStatus.OK)
  async resolveResources(
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Body() body: unknown
  ): Promise<ApiResourceResolveResponse> {
    const serviceResolveResources = (req: ResolveResourcesRequest) => this.resourcesService.resolveResources(req)

    const eitherResult = await pipe(
      body,
      validateResourceResolveRequest,
      E.chain(request => (request.resources.length > 50 ? E.left("too_many_resources" as const) : E.right(request))),
      TE.fromEither,
      TE.map(request => ({requestor, request})),
      TE.chainW(serviceResolveResources),
      logSuccess("Resources resolved", "ResourcesController", result => ({
        resolvedCount: result.resolved.length,
        deniedCount: result.denied.length
      }))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForResolveResources(eitherResult.left, "Resolving resources")

    return mapToResourceResolveResponse(eitherResult.right)
  }
}
