import {NestFactory} from "@nestjs/core"
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

  app.enableCors({
    origin: process.env.FRONTEND_URL || true,
    credentials: true, // Required for the browser to send/receive cookies and 'Authorization' headers.
    exposedHeaders: ["Location"]
  })
  app.enableShutdownHooks()
  await app.listen(3000)
}

bootstrap()
