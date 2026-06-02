import {BullModule} from "@nestjs/bull"
import {Module} from "@nestjs/common"
import {ConfigModule} from "../config.module"
import {ConfigProvider} from "../config/config-provider"

export const ACTION_TASK_QUEUE = "action-tasks"
export const WORKFLOW_STATUS_RECALCULATION_QUEUE = "workflow-status-recalculation"
export const WORKFLOW_STATUS_CHANGED_QUEUE = "workflow-status-changed"
export const WORKFLOW_ACTION_EMAIL_QUEUE = "workflow-action-email"
export const WORKFLOW_ACTION_WEBHOOK_QUEUE = "workflow-action-webhook"
export const WORKFLOW_ACTION_SLACK_QUEUE = "workflow-action-slack"
export const WORKFLOW_EXPIRATION_SWEEP_QUEUE = "workflow-expiration-sweep"

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configProvider: ConfigProvider) => ({
        redis:
          configProvider.redisConfig.connection.type === "sentinel"
            ? {
                sentinels: configProvider.redisConfig.connection.sentinels,
                name: configProvider.redisConfig.connection.name,
                sentinelPassword: configProvider.redisConfig.connection.sentinelPassword,
                password: configProvider.redisConfig.connection.password,
                db: configProvider.redisConfig.db
              }
            : {
                host: configProvider.redisConfig.connection.host,
                port: configProvider.redisConfig.connection.port,
                password: configProvider.redisConfig.connection.password,
                db: configProvider.redisConfig.db
              },
        prefix: configProvider.redisConfig.prefix
      }),
      inject: [ConfigProvider]
    }),
    BullModule.registerQueue({
      name: ACTION_TASK_QUEUE
    }),
    BullModule.registerQueue({
      name: WORKFLOW_STATUS_RECALCULATION_QUEUE
    }),
    BullModule.registerQueue({
      name: WORKFLOW_STATUS_CHANGED_QUEUE
    }),
    BullModule.registerQueue({
      name: WORKFLOW_ACTION_EMAIL_QUEUE
    }),
    BullModule.registerQueue({
      name: WORKFLOW_ACTION_WEBHOOK_QUEUE
    }),
    BullModule.registerQueue({
      name: WORKFLOW_ACTION_SLACK_QUEUE
    }),
    BullModule.registerQueue({
      name: WORKFLOW_EXPIRATION_SWEEP_QUEUE
    })
  ],
  exports: [BullModule]
})
export class QueueModule {}
