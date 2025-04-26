import {Module} from "@nestjs/common"
import {GroupsController} from "./groups"
import {UsersController} from "./users"
import {ServiceModule} from "@services/service.module"

@Module({
  imports: [ServiceModule],
  controllers: [GroupsController, UsersController],
  providers: [],
  exports: []
})
export class ControllersModule {}
