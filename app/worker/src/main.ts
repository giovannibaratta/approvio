import {NestFactory} from "@nestjs/core"
import {WorkerModule} from "./worker.module"
import {Logger} from "@nestjs/common"

async function bootstrap() {
  Logger.log("Starting worker application...")

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ["log", "error", "warn", "debug"]
  })

  Logger.log("Worker application started successfully")

  // Graceful shutdown
  let isShuttingDown = false
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    Logger.log(`${signal} received, shutting down gracefully...`)
    await app.close()
    Logger.log("Worker application closed")
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

bootstrap().catch(error => {
  console.error("Failed to start worker application", error)
  throw error
})
