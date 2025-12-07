import {v5 as uuidv5} from "uuid"

const APP_NAMESPACE = "ed5a1e57-8f46-4471-bc3f-ffbfb6914249"

export function generateDeterministicId(input: string): string {
  return uuidv5(input, APP_NAMESPACE)
}
