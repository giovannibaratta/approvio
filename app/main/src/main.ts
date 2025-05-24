import {NestFactory} from "@nestjs/core"
import {globalValidationPipe} from "./validation-pipe"
import {AppModule} from "./app.module"

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.useGlobalPipes(globalValidationPipe)
  app.enableCors({
    exposedHeaders: ["Location"]
  })
  await app.listen(3000)
}

bootstrap()
