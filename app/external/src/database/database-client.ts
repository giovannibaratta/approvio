import {Injectable, OnModuleInit} from "@nestjs/common"
import {PrismaClient} from "@prisma/client"
import {Config} from "../config"

@Injectable()
export class DatabaseClient extends PrismaClient implements OnModuleInit {
  constructor(readonly config: Config) {
    super({
      datasources: {
        db: {
          url: config.getDbConnectionUrl()
        }
      }
    })
  }

  onModuleInit() {
    this.$connect()
  }
}
