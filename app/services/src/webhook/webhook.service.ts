import {Inject, Injectable} from "@nestjs/common"
import {HttpClient, HttpClientOptions, HTTP_CLIENT_TOKEN, HttpError} from "./interfaces"
import {TaskEither} from "fp-ts/TaskEither"
import {HttpResponse} from "@domain"

@Injectable()
export class WebhookService {
  constructor(
    @Inject(HTTP_CLIENT_TOKEN)
    private readonly client: HttpClient
  ) {}

  executeWebhook(
    url: string,
    method: string,
    headers?: Record<string, string>,
    payload?: unknown,
    options?: HttpClientOptions
  ): TaskEither<HttpError, HttpResponse> {
    return this.client.execute(url, method, headers, payload, options)
  }
}
