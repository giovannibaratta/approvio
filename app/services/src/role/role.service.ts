import {SystemRole} from "@domain"
import {Injectable} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {ListRoleTemplatesError, ListRoleTemplatesResult} from "./interfaces"

@Injectable()
export class RoleService {
  /**
   * Lists all predefined role templates available in the system.
   * This is a read-only operation that returns hardcoded role templates.
   */
  listRoleTemplates(): TaskEither<ListRoleTemplatesError, ListRoleTemplatesResult> {
    return TE.right(SystemRole.getAllSystemRoleTemplates())
  }
}
