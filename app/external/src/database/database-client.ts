import {Injectable, OnModuleInit} from "@nestjs/common"
import {PrismaClient} from "@prisma/client"
import {ConfigProvider} from "../config"

@Injectable()
export class DatabaseClient extends PrismaClient implements OnModuleInit {
  constructor(readonly config: ConfigProvider) {
    super({
      datasources: {
        db: {
          url: config.dbConnectionUrl
        }
      }
    })
  }

  onModuleInit() {
    this.$connect()
  }
}
