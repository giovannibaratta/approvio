import {BadRequestException, ValidationPipe} from "@nestjs/common"

export const globalValidationPipe = new ValidationPipe({
  stopAtFirstError: false,
  exceptionFactory: errors => {
    const mappedErrors = []

    for (const error of errors) {
      for (const key in error.constraints) {
        mappedErrors.push({
          code: "VALIDATION_ERROR",
          message: error.constraints[key]
        })
      }
    }

    return new BadRequestException({
      errors: mappedErrors
    })
  }
})
