import {QueueModule} from "@external"
import {Module} from "@nestjs/common"
import {ServiceModule} from "@services/service.module"
import {v4 as uuidv4} from "uuid"
import {WorkflowRecalculationProcessor} from "./processor/workflow-recalculation.processor"
import {WorkflowEventsProcessor} from "./processor/workflow-events.processor"
import {WorkflowActionWebhookProcessor} from "./processor/workflow-action-webhook.processor"
import {WorkflowActionEmailProcessor} from "./processor/workflow-action-email.processor"
import {WORKER_ID} from "./worker.constants"

@Module({
  imports: [ServiceModule, QueueModule],
  providers: [
    WorkflowRecalculationProcessor,
    WorkflowEventsProcessor,
    WorkflowActionWebhookProcessor,
    WorkflowActionEmailProcessor,
    {
      // Initializing the worker ID here will not actually make the lock on the task safe
      // since the worker could potentially work on multiple requests in parallel. If for some
      // weird scenario, the same event is being processed by this worker, the two execution
      // will interfere with each other. This should be very unlikely.
      //
      // Initialize the worker ID for each requests should be safer but at the same time
      // we could end up more frequently in a situation where the task is basically locked
      // until the background job will force release all the locks.
      provide: WORKER_ID,
      useValue: uuidv4()
    }
  ]
})
export class WorkerModule {}
