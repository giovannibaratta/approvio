import {createHash} from "node:crypto"

export function createSha256Hash(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex")
}
