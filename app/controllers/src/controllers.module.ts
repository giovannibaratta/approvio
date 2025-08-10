import {Module} from "@nestjs/common"
import {GroupsController} from "./groups"
import {UsersController} from "./users"
import {ServiceModule} from "@services/service.module"
import {AuthModule} from "@app/auth"
import {WorkflowsController} from "./workflows"
import {WorkflowTemplatesController} from "./workflow-templates"
import {WorkflowTemplateInternalController} from "./internal"
import {AuthController} from "./auth"

const internalControllers = [WorkflowTemplateInternalController]

@Module({
  imports: [ServiceModule, AuthModule],
  controllers: [
    GroupsController,
    UsersController,
    WorkflowsController,
    WorkflowTemplatesController,
    AuthController,
    ...internalControllers
  ],
  providers: [],
  exports: []
})
export class ControllersModule {}
