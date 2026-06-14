import {SetMetadata} from "@nestjs/common"
import {LeverName} from "@services/lever"

export const LEVER_KEY = "levers"

export const UseLever = (leverName: LeverName) => SetMetadata(LEVER_KEY, leverName)
