import {Method, WireMock} from "wiremock-captain"

// We need to define the raw shape of the request coming from WireMock
// because the library returns 'unknown[]'
interface RawWireMockRequest {
  request: {
    method: string
    url: string
    headers?: Record<string, string>
    body?: string
    loggedDate?: number
  }
}

/**
 * Wiremock Request Information
 */
export interface WiremockRequest {
  headers?: Record<string, string>
  body?: string
  method: string
  url: string
}

const WIREMOCK_BASE_URL = process.env.WIREMOCK_BASE_URL

if (!WIREMOCK_BASE_URL) {
  throw new Error("WIREMOCK_BASE_URL environment variable is not set")
}

const wireMock = new WireMock(WIREMOCK_BASE_URL)

export async function setupWiremockStub(
  method: Method,
  endpoint: string,
  responseStatus: number,
  responseBody?: unknown
): Promise<void> {
  try {
    await wireMock.register(
      {
        method,
        endpoint
      },
      {
        status: responseStatus,
        body: responseBody
      }
    )
  } catch (error) {
    console.error("Failed to setup Wiremock stub:", error)
    throw new Error(`Wiremock stub setup failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    })
  }
}

function mapToWiremockRequest(request: RawWireMockRequest): WiremockRequest {
  const req = request.request
  return {
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body
  }
}

/**
 * Gets requests matching specific criteria
 */
export async function getWiremockRequestsFor(method: Method, endpointUrl: string): Promise<WiremockRequest[]> {
  try {
    const allRequests = (await wireMock.getRequestsForAPI(method, endpointUrl)) as RawWireMockRequest[]

    return allRequests.map(mapToWiremockRequest)
  } catch (error) {
    console.error("Failed to get or parse Wiremock requests:", error)
    return []
  }
}

/**
 * Creates a full Wiremock endpoint URL
 */
export function createWiremockUrl(endpoint: string): string {
  return `${WIREMOCK_BASE_URL}${endpoint}`
}
