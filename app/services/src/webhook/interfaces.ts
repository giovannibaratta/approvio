import {HttpResponse} from "@domain"
import {UnknownError} from "@services/error"
import {TaskEither} from "fp-ts/TaskEither"

export type HttpError = "http_request_failed" | "http_timeout" | UnknownError

export const HTTP_CLIENT_TOKEN = Symbol("HTTP_CLIENT_TOKEN")

export interface HttpClientOptions {
  /**
   * An optional unique key sent in the 'Idempotency-Key' header.
   * Required to enable safe retries for non-idempotent methods (e.g., POST, PATCH) unless naturally idempotent.
   */
  idempotencyKey?: string
  /**
   * Indicates if the request is idempotent.
   * Safe methods (GET, PUT, DELETE) are naturally idempotent and don't require an explicit key.
   * Non-safe methods (POST, PATCH) can be marked as idempotent if the endpoint is naturally idempotent.
   */
  isIdempotent?: boolean
}

export interface HttpClient {
  execute(
    url: string,
    method: string,
    headers?: Record<string, string>,
    payload?: unknown,
    options?: HttpClientOptions
  ): TaskEither<HttpError, HttpResponse>
}
