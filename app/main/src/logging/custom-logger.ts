import {ConsoleLogger, Injectable} from "@nestjs/common"
import {RequestContext} from "./request-context"

@Injectable()
export class CustomLogger extends ConsoleLogger {
  protected formatMessage(
    logLevel: string,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string
  ): string {
    const requestId = RequestContext.currentRequestId
    const requestIdMessage = requestId ? `[${requestId}] ` : ""

    return `${pidMessage}${timestampDiff}${formattedLogLevel}${requestIdMessage}${contextMessage}${message}\n`
  }
}
