import {NestApplication} from "@nestjs/core"
// eslint-disable-next-line node/no-unpublished-import
import * as request from "supertest"

type Method = "get" | "post" | "put" | "delete"

export class RequestBuilder {
  partialRequest: request.Test

  constructor(app: NestApplication, method: Method, endpoint: string) {
    const req = request(app.getHttpServer())

    switch (method) {
      case "get":
        this.partialRequest = req.get(endpoint)
        break
      case "post":
        this.partialRequest = req.post(endpoint)
        break
      case "put":
        this.partialRequest = req.put(endpoint)
        break
      case "delete":
        this.partialRequest = req.delete(endpoint)
        break
    }
  }

  withToken(token: string): RequestBuilder {
    this.partialRequest = this.partialRequest.set("Authorization", `Bearer ${token}`)
    return this
  }

  build(): request.Test {
    return this.partialRequest
  }

  query(params: Record<string, unknown>): RequestBuilder {
    this.partialRequest = this.partialRequest.query(params)
    return this
  }
}

export function get(app: NestApplication, endpoint: string) {
  return new RequestBuilder(app, "get", endpoint)
}

export function post(app: NestApplication, endpoint: string) {
  return new RequestBuilder(app, "post", endpoint)
}

export function put(app: NestApplication, endpoint: string) {
  return new RequestBuilder(app, "put", endpoint)
}

export function del(app: NestApplication, endpoint: string) {
  return new RequestBuilder(app, "delete", endpoint)
}
