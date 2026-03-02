import {Module} from "@nestjs/common"
import {AgentsController} from "./agents"
import {GroupsController} from "./groups"
import {OrganizationAdminController} from "./organization-admin"
import {SpacesController} from "./spaces"
import {UsersController} from "./users"
import {ServiceModule} from "@services/service.module"
import {AuthModule} from "@app/auth"
import {WorkflowsController} from "./workflows"
import {WorkflowTemplatesController} from "./workflow-templates"
import {WorkflowTemplateInternalController} from "./internal"
import {AuthController, WebAuthController, CliAuthController} from "./auth"
import {RolesController} from "./roles"
import {HealthController} from "./health"

import {ConfigModule} from "@external/config.module"

const internalControllers = [WorkflowTemplateInternalController]

@Module({
  imports: [ServiceModule, AuthModule, ConfigModule],
  controllers: [
    AgentsController,
    GroupsController,
    OrganizationAdminController,
    SpacesController,
    UsersController,
    WorkflowsController,
    WorkflowTemplatesController,
    AuthController,
    WebAuthController,
    CliAuthController,
    RolesController,
    HealthController,
    ...internalControllers
  ],
  providers: [],
  exports: []
})
export class ControllersModule {}
