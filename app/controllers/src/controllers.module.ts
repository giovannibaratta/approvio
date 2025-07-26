import {Module} from "@nestjs/common"
import {GroupsController} from "./groups"
import {UsersController} from "./users"
import {ServiceModule} from "@services/service.module"
import {AuthModule} from "@app/auth"
import {DebugController} from "./debug"
import {WorkflowsController} from "./workflows"
import {WorkflowTemplatesController} from "./workflow-templates"
import {WorkflowTemplateInternalController} from "./internal"

// List of environments where debug endpoints should be enabled
const DEBUG_ENVIRONMENTS = ["development", "test"]

// List of controller that should be loaded only if a condition is met
const conditionalControllers = []

if (DEBUG_ENVIRONMENTS.includes(process.env.ENV as string)) {
  conditionalControllers.push(DebugController)
}

const internalControllers = [WorkflowTemplateInternalController]

@Module({
  imports: [ServiceModule, AuthModule],
  controllers: [
    GroupsController,
    UsersController,
    WorkflowsController,
    WorkflowTemplatesController,
    ...conditionalControllers,
    ...internalControllers
  ],
  providers: [],
  exports: []
})
export class ControllersModule {}
