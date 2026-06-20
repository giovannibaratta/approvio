import {check} from "k6"
import {Response} from "k6/http"

export function is201(res: Response, endpoint: string) {
  return check(res, {
    [`${endpoint} status is 201`]: r => r.status === 201
  })
}

export function is200(res: Response, endpoint: string) {
  return check(res, {
    [`${endpoint} status is 200`]: r => r.status === 200
  })
}

// Helper to check if a response is successful or a known expected error under load
// (e.g., 409 Conflict due to OCC, 429 Rate Limit)
export function isSuccessOrExpectedError(res: Response, endpoint: string) {
  return check(res, {
    [`${endpoint} status is 2xx, 409, or 429`]: r =>
      (r.status >= 200 && r.status < 300) || r.status === 409 || r.status === 429
  })
}

export function extractIdFromLocation(res: Response) {
  if (res.status === 201 && res.headers) {
    // Location header might be lowercase in HTTP/2, check both
    const location = res.headers.Location || res.headers.location
    if (location && typeof location === "string") {
      const parts = location.split("/")
      return parts[parts.length - 1]
    }
  }
  return null
}


