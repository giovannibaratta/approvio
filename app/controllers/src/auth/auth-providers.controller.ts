import {Controller, Get} from "@nestjs/common"
import {ConfigProvider} from "@external/config"
import {PublicRoute} from "../../../main/src/auth/jwt.authguard"

@Controller("auth/providers")
export class AuthProvidersController {
  constructor(private readonly configProvider: ConfigProvider) {}

  @PublicRoute()
  @Get()
  getProviders(): Array<{id: string; displayName: string}> {
    const providers: Array<{id: string; displayName: string}> = []

    for (const [id, _config] of this.configProvider.oidcProviders.entries())
      // In the real system, you might get a displayName from the IDP directly or from config,
      // here we just return the ID capitalized as a default if displayName doesn't exist
      providers.push({
        id,
        displayName: id.charAt(0).toUpperCase() + id.slice(1)
      })

    return providers
  }
}
