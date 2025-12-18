import {Injectable, OnModuleInit} from "@nestjs/common"
import {PrismaClient} from "@prisma/client"
import {ConfigProvider} from "../config"
import {PrismaPg} from "@prisma/adapter-pg"

@Injectable()
export class DatabaseClient extends PrismaClient implements OnModuleInit {
  constructor(readonly config: ConfigProvider) {
    super({
      adapter: new PrismaPg({
        connectionString: config.dbConnectionUrl
      })
    })
  }

  onModuleInit() {
    this.$connect()
  }
}
