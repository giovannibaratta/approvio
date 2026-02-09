import {Controller, Get} from "@nestjs/common"
import {RoleService} from "@services"
import {isLeft} from "fp-ts/Either"
import {ListRoleTemplates200Response} from "@approvio/api"
import {generateErrorResponseForListRoleTemplates, mapRoleTemplatesToApi} from "./roles.mappers"
import {pipe} from "fp-ts/function"
import {logSuccess} from "@utils"
export const ROLES_ENDPOINT_ROOT = "roles"

@Controller(ROLES_ENDPOINT_ROOT)
export class RolesController {
  constructor(private readonly roleService: RoleService) {}

  @Get()
  async listRoleTemplates(): Promise<ListRoleTemplates200Response> {
    const result = await pipe(
      this.roleService.listRoleTemplates(),
      logSuccess("Role templates listed", "RolesController", result => ({count: result.length}))
    )()

    if (isLeft(result)) throw generateErrorResponseForListRoleTemplates(result.left, "Failed to list role templates")

    return mapRoleTemplatesToApi(result.right)
  }
}
