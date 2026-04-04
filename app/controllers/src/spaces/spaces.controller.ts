import {Space as SpaceApi, SpaceCreate, ListSpaces200Response, validateListSpacesParams} from "@approvio/api"
import {GetAuthenticatedEntity} from "@app/auth"
import {
  createSpaceApiToServiceModel,
  generateErrorResponseForCreateSpace,
  generateErrorResponseForDeleteSpace,
  generateErrorResponseForGetSpace,
  generateErrorResponseForListSpaces,
  mapListSpacesResultToApi,
  mapSpaceToApi
} from "@controllers/spaces/spaces.mappers"
import {Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Res} from "@nestjs/common"
import {CreateSpaceRequest, DeleteSpaceRequest, GetSpaceRequest, ListSpacesRequest, SpaceService} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {AuthenticatedEntity} from "@domain"
import {logSuccess} from "@utils"

export const SPACES_ENDPOINT_ROOT = "spaces"

@Controller(SPACES_ENDPOINT_ROOT)
export class SpacesController {
  constructor(private readonly spaceService: SpaceService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createSpace(
    @Body() request: SpaceCreate,
    @Res({passthrough: true}) response: Response,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    const serviceCreateSpace = (req: CreateSpaceRequest) => this.spaceService.createSpace(req)

    const eitherSpace = await pipe(
      {request, requestor},
      createSpaceApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceCreateSpace),
      logSuccess("Space created", "SpacesController", space => ({id: space.id}))
    )()

    if (isLeft(eitherSpace)) throw generateErrorResponseForCreateSpace(eitherSpace.left, "Create space")

    const space = eitherSpace.right
    const location = `${response.req.protocol}://${response.req.headers.host}${response.req.url}/${space.id}`
    response.setHeader("Location", location)
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async listSpaces(
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Query() query: Record<string, unknown>
  ): Promise<ListSpaces200Response> {
    const serviceListSpaces = (request: ListSpacesRequest) => this.spaceService.listSpaces(request)

    const eitherSpaces = await pipe(
      query,
      validateListSpacesParams,
      TE.fromEither,
      TE.map(params => {
        return {
          page: params.page ?? 1,
          limit: params.limit ?? 20,
          search: params.search,
          requestor
        }
      }),
      TE.chainW(serviceListSpaces),
      logSuccess("Spaces listed", "SpacesController", result => ({
        count: result.spaces.length,
        total: result.total
      }))
    )()

    if (isLeft(eitherSpaces)) throw generateErrorResponseForListSpaces(eitherSpaces.left, "List spaces")
    return mapListSpacesResultToApi(eitherSpaces.right)
  }

  @Get(":spaceId")
  @HttpCode(HttpStatus.OK)
  async getSpace(
    @Param("spaceId") spaceId: string,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<SpaceApi> {
    const serviceGetSpace = (request: GetSpaceRequest) => this.spaceService.getSpace(request)

    const eitherSpace = await pipe(
      {spaceId, requestor},
      TE.right,
      TE.chainW(serviceGetSpace),
      logSuccess("Space retrieved", "SpacesController", space => ({id: space.id}))
    )()

    if (isLeft(eitherSpace)) throw generateErrorResponseForGetSpace(eitherSpace.left, "Get space")

    return mapSpaceToApi(eitherSpace.right)
  }

  @Delete(":spaceId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSpace(
    @Param("spaceId") spaceId: string,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    const serviceDeleteSpace = (request: DeleteSpaceRequest) => this.spaceService.deleteSpace(request)

    const eitherResult = await pipe(
      {spaceId, requestor},
      TE.right,
      TE.chainW(serviceDeleteSpace),
      logSuccess("Space deleted", "SpacesController", () => ({spaceId}))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForDeleteSpace(eitherResult.left, "Delete space")
  }
}
