import {BullModule} from "@nestjs/bull"
import {Module} from "@nestjs/common"
import {ConfigModule} from "../config.module"
import {ConfigProvider} from "../config/config-provider"

export const ACTION_TASK_QUEUE = "action-tasks"
export const WORKFLOW_STATUS_RECALCULATION_QUEUE = "workflow-status-recalculation"

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configProvider: ConfigProvider) => ({
        redis: {
          host: configProvider.redisConfig.host,
          port: configProvider.redisConfig.port,
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
    })
  ],
  exports: [BullModule]
})
export class QueueModule {}
