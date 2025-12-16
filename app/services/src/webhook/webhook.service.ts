import {Inject, Injectable} from "@nestjs/common"
import {HttpClient, HTTP_CLIENT_TOKEN, HttpError, HttpResponse} from "./interfaces"
import {TaskEither} from "fp-ts/TaskEither"

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
    payload?: unknown
  ): TaskEither<HttpError, HttpResponse> {
    return this.client.execute(url, method, headers, payload)
  }
}
