import {BadRequestException, ValidationPipe} from "@nestjs/common"
import {generateErrorPayload} from "@controllers/error"

export const globalValidationPipe = new ValidationPipe({
  stopAtFirstError: false,
  exceptionFactory: errors => {
    const mappedErrors = []

    for (const error of errors) {
      for (const key in error.constraints) {
        mappedErrors.push(error.constraints[key])
      }
    }

    return new BadRequestException(generateErrorPayload("VALIDATION_ERROR", mappedErrors.join(",")))
  }
})
