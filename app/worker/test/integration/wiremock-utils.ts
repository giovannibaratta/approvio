import axios from "axios"

// TODO: Replace with wiremock-captain or wiremock-rest-client

/**
 * Wiremock Utility Functions
 *
 * This utility provides helper functions for interacting with the Wiremock server
 * that runs as a docker container for integration testing.
 *
 * The Wiremock server runs on port 9090 and provides a REST API for:
 * - Setting up stubs (mock endpoints)
 * - Verifying requests
 * - Resetting state
 * - Managing mappings
 */

const WIREMOCK_BASE_URL = "http://localhost:9090"
const WIREMOCK_ADMIN_API = `${WIREMOCK_BASE_URL}/__admin`

/**
 * Wiremock HTTP Method types
 */
export type WiremockHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

/**
 * Wiremock Stub Configuration
 */
export interface WiremockStubConfig {
  request: {
    method: WiremockHttpMethod
    url: string
    headers?: Record<string, string>
    bodyPatterns?: unknown[]
  }
  response: {
    status: number
    body?: unknown
    headers?: Record<string, string>
    delay?: number
  }
}

/**
 * Wiremock Request Information
 */
export interface WiremockRequest {
  requestLine: string
  headers: Record<string, string>
  body: string
  method: string
  url: string
  timestamp: number
}

/**
 * Wiremock Requests Response from Admin API
 */
export interface WiremockRequestsResponse {
  requests: WiremockRequest[]
}

/**
 * Sets up a new stub mapping in Wiremock
 *
 * @param config - The stub configuration
 * @returns Promise that resolves when the stub is created
 */
export async function setupWiremockStub(config: WiremockStubConfig): Promise<void> {
  try {
    // Convert body to string if it's an object
    const stubData = {
      ...config,
      response: {
        ...config.response,
        body: typeof config.response.body === "object" ? JSON.stringify(config.response.body) : config.response.body
      }
    }

    await axios.post(`${WIREMOCK_ADMIN_API}/mappings`, stubData, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  } catch (error) {
    console.error("Failed to setup Wiremock stub:", error)
    throw new Error(`Wiremock stub setup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Sets up a simple stub with JSON response
 *
 * @param method - HTTP method
 * @param url - URL path
 * @param status - HTTP status code
 * @param responseBody - Response body (will be JSON stringified)
 * @param headers - Optional response headers
 */
export async function setupSimpleStub(
  method: WiremockHttpMethod,
  url: string,
  status: number,
  responseBody: unknown,
  headers: Record<string, string> = {"Content-Type": "application/json"}
): Promise<void> {
  await setupWiremockStub({
    request: {
      method,
      url
    },
    response: {
      status,
      body: responseBody,
      headers
    }
  })
}

/**
 * Gets all recorded requests from Wiremock
 *
 * @returns Promise that resolves with an array of WiremockRequest objects
 */
export async function getWiremockRequests(): Promise<WiremockRequest[]> {
  try {
    const response = await axios.get(`${WIREMOCK_ADMIN_API}/requests`)
    const rawRequests = response.data.requests || []

    // Transform the nested Wiremock response structure to our flat interface
    return rawRequests.map((item: unknown) => {
      const req = item as {
        request: {url: string; method: string; headers?: Record<string, string>; body?: string; loggedDate?: number}
      }
      return {
        url: req.request.url,
        method: req.request.method,
        headers: req.request.headers || {},
        body: req.request.body || "",
        requestLine: `${req.request.method} ${req.request.url} HTTP/1.1`,
        timestamp: req.request.loggedDate || Date.now()
      }
    })
  } catch (error) {
    console.error("Failed to get Wiremock requests:", error)
    return []
  }
}

/**
 * Gets requests matching specific criteria
 *
 * @param method - Optional HTTP method to filter by
 * @param url - Optional URL to filter by
 * @returns Promise that resolves with filtered WiremockRequest objects
 */
export async function getWiremockRequestsBy(method?: WiremockHttpMethod, url?: string): Promise<WiremockRequest[]> {
  const allRequests = await getWiremockRequests()

  return allRequests.filter(request => {
    const methodMatch = method ? request.method === method : true
    const urlMatch = url ? request.url === url : true
    return methodMatch && urlMatch
  })
}

// TODO: Reset should be for specific endpoints since tests can be executed in parallel

/**
 * Resets Wiremock state (clears all stubs and recorded requests)
 *
 * @returns Promise that resolves when reset is complete
 */
export async function resetWiremock(): Promise<void> {
  try {
    await axios.post(`${WIREMOCK_ADMIN_API}/reset`)
  } catch (error) {
    console.error("Failed to reset Wiremock:", error)
    throw new Error(`Wiremock reset failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Verifies that a request was made to Wiremock
 *
 * @param method - HTTP method to verify
 * @param url - URL to verify
 * @param expectedCount - Expected number of requests (default: 1)
 * @returns Promise that resolves if the request was found, rejects otherwise
 */
export async function verifyWiremockRequest(
  method: WiremockHttpMethod,
  url: string,
  expectedCount: number = 1
): Promise<void> {
  const requests = await getWiremockRequestsBy(method, url)

  if (requests.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} ${method} request(s) to ${url}, but found ${requests.length}`)
  }
}

/**
 * Verifies that a request was made with specific body content
 *
 * @param method - HTTP method to verify
 * @param url - URL to verify
 * @param expectedBody - Expected body content (string or object)
 * @returns Promise that resolves if the request with matching body was found, rejects otherwise
 */
export async function verifyWiremockRequestWithBody(
  method: WiremockHttpMethod,
  url: string,
  expectedBody: unknown
): Promise<void> {
  const requests = await getWiremockRequestsBy(method, url)

  if (requests.length === 0) {
    throw new Error(`No ${method} requests found for ${url}`)
  }

  const expectedBodyString = typeof expectedBody === "object" ? JSON.stringify(expectedBody) : expectedBody

  const matchingRequest = requests.find(request => {
    try {
      const requestBody = request.body ? JSON.parse(request.body) : {}
      const requestBodyString = JSON.stringify(requestBody)
      return requestBodyString === expectedBodyString
    } catch {
      return request.body === expectedBodyString
    }
  })

  if (!matchingRequest) {
    throw new Error(`No ${method} request to ${url} found with expected body: ${expectedBodyString}`)
  }
}

/**
 * Verifies that a request was made with specific headers
 *
 * @param method - HTTP method to verify
 * @param url - URL to verify
 * @param expectedHeaders - Expected headers (key-value pairs)
 * @returns Promise that resolves if the request with matching headers was found, rejects otherwise
 */
export async function verifyWiremockRequestWithHeaders(
  method: WiremockHttpMethod,
  url: string,
  expectedHeaders: Record<string, string>
): Promise<void> {
  const requests = await getWiremockRequestsBy(method, url)

  if (requests.length === 0) {
    throw new Error(`No ${method} requests found for ${url}`)
  }

  const request = requests[0]
  const headerMatches = Object.entries(expectedHeaders).every(([key, value]) => {
    const actualValue = request?.headers[key.toLowerCase()]
    return actualValue && actualValue.includes(value)
  })

  if (!headerMatches) {
    const actualHeaders = JSON.stringify(request?.headers)
    const expectedHeadersString = JSON.stringify(expectedHeaders)
    throw new Error(`Request headers don't match. Expected: ${expectedHeadersString}, Actual: ${actualHeaders}`)
  }
}

/**
 * Gets the Wiremock base URL for creating test endpoints
 *
 * @returns The base URL for Wiremock endpoints
 */
export function getWiremockBaseUrl(): string {
  return WIREMOCK_BASE_URL
}

/**
 * Creates a full Wiremock endpoint URL
 *
 * @param path - The endpoint path
 * @returns Full URL including Wiremock base URL
 */
export function createWiremockEndpoint(path: string): string {
  return `${WIREMOCK_BASE_URL}${path}`
}
