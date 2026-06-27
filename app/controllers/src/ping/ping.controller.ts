import {Controller, Get} from "@nestjs/common"
import {PublicRoute} from "../../../main/src/auth/jwt.authguard"

@Controller("ping")
export class PingController {
  @PublicRoute()
  @Get()
  getPing(): {status: "OK"} {
    return {status: "OK"}
  }
}
