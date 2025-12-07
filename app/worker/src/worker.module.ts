import {QueueModule} from "@external"
import {Module} from "@nestjs/common"
import {ServiceModule} from "@services/service.module"
import {WorkflowRecalculationProcessor} from "./processor/workflow-recalculation.processor"
import {WorkflowEventsProcessor} from "./processor/workflow-events.processor"

@Module({
  imports: [ServiceModule, QueueModule],
  providers: [WorkflowRecalculationProcessor, WorkflowEventsProcessor]
})
export class WorkerModule {}
