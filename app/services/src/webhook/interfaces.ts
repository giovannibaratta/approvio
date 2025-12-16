import {UnknownError} from "@services/error"
import {TaskEither} from "fp-ts/TaskEither"
import {ResponseBodyStatus} from "@domain"

export type HttpError = "http_request_failed" | "http_timeout" | UnknownError

export interface HttpResponse {
  status: number
  body?: string
  bodyStatus: ResponseBodyStatus
}

export const HTTP_CLIENT_TOKEN = Symbol("HTTP_CLIENT_TOKEN")

export interface HttpClient {
  execute(
    url: string,
    method: string,
    headers?: Record<string, string>,
    payload?: unknown
  ): TaskEither<HttpError, HttpResponse>
}
