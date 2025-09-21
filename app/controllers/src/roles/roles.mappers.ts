import {RoleTemplate as RoleTemplateApi} from "@approvio/api"
import {RoleTemplate} from "@domain"
import {HttpException, InternalServerErrorException} from "@nestjs/common"
import {ListRoleTemplatesError} from "@services"
import {generateErrorPayload} from "../error"

export function mapRoleTemplateToApi(roleTemplate: RoleTemplate): RoleTemplateApi {
  return {
    name: roleTemplate.name,
    permissions: [...roleTemplate.permissions],
    scope: roleTemplate.scopeType
  }
}

export function mapRoleTemplatesToApi(roleTemplates: ReadonlyArray<RoleTemplate>) {
  return {
    roles: roleTemplates.map(mapRoleTemplateToApi)
  }
}

export function generateErrorResponseForListRoleTemplates(
  error: ListRoleTemplatesError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: An unexpected error occurred`)
      )
  }
}
