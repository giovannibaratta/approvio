import {Module} from "@nestjs/common"
import {ControllersModule} from "@controllers/controllers.module"
import {AuthModule} from "./auth/auth.module"

@Module({
  imports: [ControllersModule, AuthModule],
  controllers: [],
  providers: []
})
export class AppModule {}
