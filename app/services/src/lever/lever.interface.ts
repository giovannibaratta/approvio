import {EvaluationContext} from "@openfeature/server-sdk"
import {LeverName} from "./lever.service"
import {TaskEither} from "fp-ts/TaskEither"

export type LeverError = "lever_provider_error" | "lever_not_found"

export interface LeverProvider {
  isLeverActive(
    leverName: LeverName,
    defaultValue: boolean,
    context?: EvaluationContext
  ): TaskEither<LeverError, boolean>
}

export const LEVER_PROVIDER_TOKEN = Symbol("LEVER_PROVIDER_TOKEN")
