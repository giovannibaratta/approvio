import {PersistenceModule, QueueModule} from "@external"
import {Module} from "@nestjs/common"
import {ServiceModule} from "@services/service.module"
import {v7 as uuidv7} from "uuid"
import {WorkflowRecalculationProcessor} from "./processor/workflow-recalculation.processor"
import {WorkflowEventsProcessor} from "./processor/workflow-events.processor"
import {WorkflowActionWebhookProcessor} from "./processor/workflow-action-webhook.processor"
import {WorkflowActionEmailProcessor} from "./processor/workflow-action-email.processor"
import {WorkflowActionSlackProcessor} from "./processor/workflow-action-slack.processor"
import {WorkflowExpirationSweepProcessor} from "./processor/workflow-expiration-sweep.processor"
import {TenantOutboxRelayProcessor} from "./processor/tenant-outbox-relay.processor"
import {WORKER_ID} from "./worker.constants"
import {WORKFLOW_RECALCULATION_TOKEN} from "@services/durable-work/interfaces"
import {WorkflowRecalculationService} from "@services/workflow/workflow-recalculation.service"

@Module({
  // TODO: Reason for importing the PersistenceModule ?
  imports: [ServiceModule, PersistenceModule, QueueModule],
  providers: [
    WorkflowRecalculationProcessor,
    WorkflowEventsProcessor,
    WorkflowActionWebhookProcessor,
    WorkflowActionEmailProcessor,
    WorkflowActionSlackProcessor,
    WorkflowExpirationSweepProcessor,
    TenantOutboxRelayProcessor,
    // TODO: Why do we need this explicit import. Isn't this included in the ServiceModule ?
    {
      provide: WORKFLOW_RECALCULATION_TOKEN,
      useExisting: WorkflowRecalculationService
    },
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
      useValue: uuidv7()
    }
  ]
})
export class WorkerModule {}
