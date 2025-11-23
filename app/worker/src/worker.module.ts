import {Module} from "@nestjs/common"
import {ServiceModule} from "@services/service.module"
import {WorkflowRecalculationProcessor} from "./processor/workflow-recalculation.processor"

@Module({
  imports: [ServiceModule],
  providers: [WorkflowRecalculationProcessor]
})
export class WorkerModule {}
