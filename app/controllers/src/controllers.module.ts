import {Module} from "@nestjs/common"
import {ServiceModule} from "@services"
import {GroupsController} from "./groups"

@Module({
  imports: [ServiceModule],
  controllers: [GroupsController],
  providers: [],
  exports: []
})
export class ControllersModule {}
