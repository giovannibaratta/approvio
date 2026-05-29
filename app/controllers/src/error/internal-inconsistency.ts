import {InternalServerErrorException, Logger} from "@nestjs/common"
import {generateErrorPayload} from "@controllers/error"

export function handleInternalInconsistency(errorCode: string, context: string): InternalServerErrorException {
  Logger.error(`Internal data inconsistency: ${errorCode}`)
  return new InternalServerErrorException(
    generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
  )
}
