import {NestFactory} from "@nestjs/core"
import {AppModule} from "./app.module"
import {Logger, LogLevel} from "@nestjs/common"
import {CustomLogger} from "./logging/custom-logger"
import {Request, Response, NextFunction} from "express"

function isDevOrTestEnv(): boolean {
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
}

function allowedOrigin(): string | boolean {
  if (isDevOrTestEnv()) return process.env.FRONTEND_URL || true

  const frontendUrl = process.env.FRONTEND_URL

  if (!frontendUrl) throw new Error("FRONTEND_URL must be set in production environment")

  return frontendUrl
}

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

  if (process.env.ENV === "development") {
    Logger.log("Injecting middleware to log OPTIONS requests in development environment.")
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.method === "OPTIONS") Logger.debug(`Received OPTIONS request for ${req.url}`)
      next()
    })
  }

  const origin = allowedOrigin()

  app.enableCors({
    origin,
    credentials: true, // Required for the browser to send/receive cookies and 'Authorization' headers.
    exposedHeaders: ["Location"]
  })
  app.enableShutdownHooks()
  await app.listen(3000)
}

void bootstrap()
