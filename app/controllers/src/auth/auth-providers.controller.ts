import {Controller, Get, Header} from "@nestjs/common"
import {AuthService} from "@services"
import {AuthProvider} from "@approvio/api"
import {PublicRoute} from "@app/auth"

@Controller("auth/providers")
export class AuthProvidersController {
  constructor(private readonly authService: AuthService) {}

  @PublicRoute()
  @Header("Cache-Control", "public, max-age=300")
  @Get()
  async getProviders(): Promise<Array<AuthProvider>> {
    return await this.authService.getAvailableAuthProviders()()
  }
}
