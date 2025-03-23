import {Injectable} from "@nestjs/common"

@Injectable()
export class Config {
  private readonly dbConnectionUrl: string

  constructor() {
    const connectionUrl = process.env.DATABASE_URL

    if (connectionUrl === undefined) throw new Error("DATABASE_URL is not defined")

    this.dbConnectionUrl = connectionUrl
  }

  getDbConnectionUrl(): string {
    return this.dbConnectionUrl
  }
}
