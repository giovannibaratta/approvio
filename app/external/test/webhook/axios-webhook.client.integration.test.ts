import {v7 as uuidv7} from "uuid"
import {Test, TestingModule} from "@nestjs/testing"

import {AxiosWebhookClient} from "@external/webhook/axios-webhook.client"
import {ConfigProvider} from "@external/config"
import {createWiremockUrl, getWiremockRequestsFor, setupWiremockStub} from "@test/wiremock"
import {unwrapRight} from "@utils/either"
import {ResponseBodyStatus} from "@domain"
import {MockConfigProvider} from "@test/mock-data"
import {SilentLogger} from "@test/logger-helpers"

describe("AxiosWebhookClient (Integration)", () => {
  let client: AxiosWebhookClient
  let mockConfigProvider: MockConfigProvider
  let endpoint: string
  let wiremockUrl: string

  beforeEach(async () => {
    mockConfigProvider = MockConfigProvider.fromOriginalProvider({
      webhookRetryConfig: {
        maxAttempts: 3,
        initialDelayMs: 0,
        backoffFactor: 1,
        maxDelayMs: 0
      }
    })

    mockConfigProvider.ssrfProtectionConfig = {
      mode: "strict",
      allowedDestinations: ["localhost"] // Allow localhost for wiremock to work
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AxiosWebhookClient,
        {
          provide: ConfigProvider,
          useValue: mockConfigProvider
        }
      ]
    })
      .setLogger(new SilentLogger())
      .compile()

    client = module.get<AxiosWebhookClient>(AxiosWebhookClient)
    endpoint = `/test-axios-client-${uuidv7()}`
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

    it("should reject SSRF attempts when strict mode is active", async () => {
      // Given
      const blockedUrl = "http://169.254.169.254/latest/meta-data/"

      // When
      const result = await client.execute(blockedUrl, "GET")()

      // Then
      expect(result).toBeLeftOf("ssrf_blocked")
    })

    it("should allow SSRF attempts when mode is disabled", async () => {
      // Given
      mockConfigProvider.ssrfProtectionConfig = {mode: "disabled"}

      // We point to a closed port on loopback just to see if it tries to connect
      // instead of blocking immediately for SSRF
      const unreachableUrl = "http://127.0.0.1:54321/nowhere"

      // Re-initialize client with the updated config provider for this test
      const testClient = new AxiosWebhookClient(mockConfigProvider as ConfigProvider)

      // When
      const result = await testClient.execute(unreachableUrl, "GET")()

      // Then
      expect(result).toBeLeftOf("http_request_failed")
    })

    it("should reject invalid protocols", async () => {
      // Given
      const invalidUrl = "file:///etc/passwd"

      // When
      const result = await client.execute(invalidUrl, "GET")()

      // Then
      expect(result).toBeLeftOf("ssrf_blocked")
    })

    describe("retries", () => {
      it("should automatically retry safe methods (like GET) on transient errors", async () => {
        // Given
        await setupWiremockStub("GET", endpoint, 500, {error: "Transient Error"})

        // When
        const eitherResult = await client.execute(wiremockUrl, "GET")()

        // Then
        expect(eitherResult).toBeRight()

        // Assert exactly 3 calls (1 initial + 2 retries)
        const requests = await getWiremockRequestsFor("GET", endpoint)
        expect(requests).toHaveLength(3)
      })

      it("should NOT retry non-transient errors (like 404)", async () => {
        // Given
        await setupWiremockStub("GET", endpoint, 404, {error: "Not Found"})

        // When
        const eitherResult = await client.execute(wiremockUrl, "GET")()

        // Then
        expect(eitherResult).toBeRight()

        // Assert exactly 1 call (no retries)
        const requests = await getWiremockRequestsFor("GET", endpoint)
        expect(requests).toHaveLength(1)
      })

      it("should NOT retry non-safe methods (like POST) without idempotency key or isIdempotent flag", async () => {
        // Given
        await setupWiremockStub("POST", endpoint, 500, {error: "Transient Error"})

        // When
        const eitherResult = await client.execute(wiremockUrl, "POST", undefined, {data: "test"})()

        // Then
        expect(eitherResult).toBeRight()

        // Assert exactly 1 call (no retries because it's not safe and not idempotent)
        const requests = await getWiremockRequestsFor("POST", endpoint)
        expect(requests).toHaveLength(1)
      })

      it("should retry non-safe methods (like POST) when idempotencyKey is provided", async () => {
        // Given
        await setupWiremockStub("POST", endpoint, 500, {error: "Transient Error"})

        // When
        const eitherResult = await client.execute(
          wiremockUrl,
          "POST",
          undefined,
          {data: "test"},
          {
            idempotencyKey: "test-idempotency-key"
          }
        )()

        // Then
        expect(eitherResult).toBeRight()

        // Assert exactly 3 calls (1 initial + 2 retries)
        const requests = await getWiremockRequestsFor("POST", endpoint)
        expect(requests).toHaveLength(3)
      })
    })
  })
})
