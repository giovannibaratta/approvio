import {HttpResponse} from "@domain"
import {UnknownError} from "@services/error"
import {TaskEither} from "fp-ts/TaskEither"

export type HttpError = "http_request_failed" | "http_timeout" | UnknownError

export const HTTP_CLIENT_TOKEN = Symbol("HTTP_CLIENT_TOKEN")

export interface HttpClientOptions {
  idempotencyKey?: string
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
