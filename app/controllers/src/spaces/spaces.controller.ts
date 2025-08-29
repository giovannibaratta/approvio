import {Space as SpaceApi, SpaceCreate, ListSpaces200Response} from "@approvio/api"
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
import {
  AuthenticatedEntity,
  CreateSpaceRequest,
  DeleteSpaceRequest,
  GetSpaceRequest,
  ListSpacesRequest,
  SpaceService
} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"

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
      TE.chainW(serviceCreateSpace)
    )()

    if (isLeft(eitherSpace)) throw generateErrorResponseForCreateSpace(eitherSpace.left, "Create space")

    const space = eitherSpace.right
    const location = `${response.req.protocol}://${response.req.headers.host}${response.req.url}/${space.id}`
    response.setHeader("Location", location)
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async listSpaces(
    @Query("page") pageQuery: string,
    @Query("limit") limitQuery: string,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<ListSpaces200Response> {
    const validateAndParseParams = (pageStr?: string, limitStr?: string) => {
      const page = pageStr ? parseInt(pageStr, 10) : undefined
      const limit = limitStr ? parseInt(limitStr, 10) : undefined

      if (page !== undefined && isNaN(page)) return TE.left("invalid_page" as const)
      if (limit !== undefined && isNaN(limit)) return TE.left("invalid_limit" as const)

      return TE.right({page, limit, requestor})
    }

    const serviceListSpaces = (request: ListSpacesRequest) => this.spaceService.listSpaces(request)

    const eitherSpaces = await pipe(validateAndParseParams(pageQuery, limitQuery), TE.chainW(serviceListSpaces))()

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

    const eitherSpace = await pipe({spaceId, requestor}, TE.right, TE.chainW(serviceGetSpace))()

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

    const eitherResult = await pipe({spaceId, requestor}, TE.right, TE.chainW(serviceDeleteSpace))()

    if (isLeft(eitherResult)) throw generateErrorResponseForDeleteSpace(eitherResult.left, "Delete space")
  }
}
