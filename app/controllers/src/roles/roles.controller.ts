import {Controller, Get} from "@nestjs/common"
import {RoleService} from "@services"
import {isLeft} from "fp-ts/Either"
import {ListRoleTemplates200Response} from "@approvio/api"
import {generateErrorResponseForListRoleTemplates, mapRoleTemplatesToApi} from "./roles.mappers"
export const ROLES_ENDPOINT_ROOT = "roles"

@Controller(ROLES_ENDPOINT_ROOT)
export class RolesController {
  constructor(private readonly roleService: RoleService) {}

  @Get()
  async listRoleTemplates(): Promise<ListRoleTemplates200Response> {
    const result = await this.roleService.listRoleTemplates()()

    if (isLeft(result)) throw generateErrorResponseForListRoleTemplates(result.left, "Failed to list role templates")

    return mapRoleTemplatesToApi(result.right)
  }
}
