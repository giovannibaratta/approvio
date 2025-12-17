import {Test, TestingModule} from "@nestjs/testing"

import {AxiosWebhookClient} from "@external/webhook/axios-webhook.client"
import {createWiremockUrl, getWiremockRequestsFor, setupWiremockStub} from "@test/wiremock"
import {unwrapRight} from "@utils/either"
import {ResponseBodyStatus} from "@domain"
import {Chance} from "chance"

describe("AxiosWebhookClient (Integration)", () => {
  let client: AxiosWebhookClient
  let endpoint: string
  let wiremockUrl: string
  let chance: Chance.Chance

  beforeEach(async () => {
    chance = new Chance()
    const module: TestingModule = await Test.createTestingModule({
      providers: [AxiosWebhookClient]
    }).compile()

    client = module.get<AxiosWebhookClient>(AxiosWebhookClient)
    endpoint = `/test-axios-client-${chance.guid()}`
    wiremockUrl = createWiremockUrl(endpoint)
  })

  it("should be defined", () => {
    expect(client).toBeDefined()
  })

  describe("execute", () => {
    it("should successfully make a GET request and parse JSON response", async () => {
      // Given
      const expectedBody = {message: "success", id: 123}
      await setupWiremockStub("GET", endpoint, 200, expectedBody)

      // When
      const eitherResult = await client.execute(wiremockUrl, "GET")()

      // Then
      expect(eitherResult).toBeRight()
      const result = unwrapRight(eitherResult)

      const {status, body, bodyStatus} = result
      expect(status).toBe(200)
      expect(bodyStatus).toBe(ResponseBodyStatus.OK)
      // The client stringifies objects, so we expect a string representation
      expect(body).toBe(JSON.stringify(expectedBody))

      // Verify Wiremock received the request
      const requests = await getWiremockRequestsFor("GET", endpoint)
      expect(requests).toHaveLength(1)
    })

    it("should handle string responses correctly", async () => {
      // Given
      const expectedString = "plain text response"

      await setupWiremockStub("POST", endpoint, 201, expectedString)

      // When
      const eitherResult = await client.execute(wiremockUrl, "POST", {"Content-Type": "text/plain"}, {data: "test"})()

      // Then
      expect(eitherResult).toBeRight()
      const result = unwrapRight(eitherResult)
      expect(result.status).toBe(201)
      expect(result.body).toBe(expectedString)
      expect(result.bodyStatus).toBe(ResponseBodyStatus.OK)
    })

    it("should treat 4xx/5xx errors as successful responses (validateStatus strategy)", async () => {
      // Given
      const errorBody = {error: "Not Found"}

      await setupWiremockStub("GET", endpoint, 404, errorBody)

      // When
      const eitherResult = await client.execute(wiremockUrl, "GET")()

      // Then
      expect(eitherResult).toBeRight()
      const result = unwrapRight(eitherResult)
      expect(result.status).toBe(404)
      expect(result.bodyStatus).toBe(ResponseBodyStatus.OK)
      expect(result.body).toBe(JSON.stringify(errorBody))
    })

    it("should truncate the body if response exceeds 10KB", async () => {
      // Given
      // Create a string slightly larger than 10KB (10000 chars)
      const largeBody = "x".repeat(10050)

      await setupWiremockStub("GET", endpoint, 200, largeBody)

      // When
      const eitherResult = await client.execute(wiremockUrl, "GET")()

      // Then
      expect(eitherResult).toBeRight()
      const result = unwrapRight(eitherResult)
      expect(result.status).toBe(200)
      expect(result.bodyStatus).toBe(ResponseBodyStatus.TRUNCATED)
      expect(result.body?.length).toBe(10000) // Should be exactly MAX_BODY_LENGTH
      expect(result.body).toBe("x".repeat(10000))
    })

    it("should return http_request_failed for network errors (unreachable host)", async () => {
      // Given
      // We point to a port that is definitely closed/not running Wiremock
      const unreachableUrl = "http://localhost:54321/nowhere"

      // When
      const result = await client.execute(unreachableUrl, "GET")()

      // Then
      expect(result).toBeLeftOf("http_request_failed")
    })

    it("should handle undefined/empty body", async () => {
      // Given

      // Wiremock setup for 204 No Content (usually has no body)
      await setupWiremockStub("DELETE", endpoint, 204)

      // When
      const result = await client.execute(wiremockUrl, "DELETE")()

      // Then
      expect(result).toBeRightOf({status: 204, bodyStatus: ResponseBodyStatus.MISSING, body: undefined})
    })
  })
})
