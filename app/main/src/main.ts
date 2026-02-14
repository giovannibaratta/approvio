import {NestFactory} from "@nestjs/core"
import {globalValidationPipe} from "./validation-pipe"
import {AppModule} from "./app.module"
import {LogLevel} from "@nestjs/common"
import {CustomLogger} from "./logging/custom-logger"

async function bootstrap() {
  const logLevels: LogLevel[] = ["log", "error", "warn"]

  if (process.env.LOG_LEVEL === "trace") {
    logLevels.push("verbose")
    logLevels.push("debug")
  }

  const logger = new CustomLogger("backend", {
    timestamp: true,
    logLevels
  })

  const app = await NestFactory.create(AppModule, {logger: logger})

  app.useGlobalPipes(globalValidationPipe)
  app.enableCors({
    exposedHeaders: ["Location"]
  })
  app.enableShutdownHooks()
  await app.listen(3000)
}

bootstrap()
