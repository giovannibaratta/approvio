import http from "k6/http"
import {sleep} from "k6"
import {getRandomTemplate, getRandomVoterForTemplate} from "../../lib/auth.ts"
import {is201, is200, extractIdFromLocation, isSuccessOrExpectedError} from "../../lib/checks.ts"
import {generateWorkflowPayload, generateVotePayload} from "../../lib/data-gen.ts"
import {htmlReport} from "https://raw.githubusercontent.com/benc-uk/k6-reporter/3.0.4/dist/bundle.js"
import {textSummary} from "https://jslib.k6.io/k6-summary/0.1.0/index.js"
import {trackResponse} from "../../lib/metrics.ts"

function checkAndLogResponse(res: any, name: string) {
  if (res.status >= 400) {
    console.warn(`[ERROR] ${name} failed with status ${res.status}. Response: ${res.body}`)
  }
}

// Use environment variable for base URL or default to localhost
const BASE_URL = __ENV.API_URL || "http://localhost:3000"
const THINK_TIME = parseFloat(__ENV.THINK_TIME || "1")

// Setup lifecycle hook to log that the test is starting and document the scenario being tested
export function setup() {
  console.log("Starting workflow-crud scenario...")
  console.log("This scenario simulates the following user journey:")
  console.log("  1. Select a random workflow template and authorized voter from seed-data.json")
  console.log("  2. Create a new workflow (POST /workflows)")
  console.log("  3. Fetch the created workflow status (GET /workflows/{id})")
  console.log("  4. Submit a vote on the workflow (POST /workflows/{id}/vote)")
  console.log(`Think time: ${THINK_TIME}s`)
  console.log(`Base URL: ${BASE_URL}`)
}

// Sleeps (think times) simulate real-world user behavior between requests.
// It keeps the transaction rate per VU realistic and prevents VUs from hammering the system in tight loops.
export default function () {
  // 1. Setup Data for this VU Iteration
  const template = getRandomTemplate()
  const voter = getRandomVoterForTemplate(template)

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${voter.token}`
  }

  // 2. Create Workflow
  const wfPayload = generateWorkflowPayload(template.id)
  const createRes = http.post(`${BASE_URL}/workflows`, JSON.stringify(wfPayload), {headers})

  trackResponse(createRes, "POST /workflows")
  checkAndLogResponse(createRes, "POST /workflows")
  is201(createRes, "POST /workflows")

  const workflowId = extractIdFromLocation(createRes)

  if (!workflowId) {
    // If we failed to create a workflow, wait and abort this iteration
    if (THINK_TIME > 0) sleep(THINK_TIME)
    else sleep(0.1) // prevent infinite hot loops on failure

    return
  }

  // Brief pause to simulate user think time
  if (THINK_TIME > 0) sleep(THINK_TIME)

  // 3. Get Workflow Status
  const getRes = http.get(`${BASE_URL}/workflows/${workflowId}`, {headers})
  trackResponse(getRes, "GET /workflows/{id}")
  checkAndLogResponse(getRes, `GET /workflows/${workflowId}`)
  is200(getRes, "GET /workflows/{id}")

  if (THINK_TIME > 0) sleep(THINK_TIME)

  // 4. Submit a Vote
  const votePayload = generateVotePayload(voter.groupId)
  const voteRes = http.post(`${BASE_URL}/workflows/${workflowId}/vote`, JSON.stringify(votePayload), {headers})

  trackResponse(voteRes, "POST /workflows/{id}/vote")
  // A 409 status code represents database transaction contention on Optimistic Concurrency Control (OCC).
  // This is tracked as a custom counter `error_CONCURRENCY_CONFLICT` in `trackResponse` to monitor if backend contention is excessive.

  // We'll track it with a relaxed check that allows for expected failure states under load
  checkAndLogResponse(voteRes, `POST /workflows/${workflowId}/vote`)
  isSuccessOrExpectedError(voteRes, "POST /workflows/{id}/vote")
}

export function handleSummary(data: any) {
  return {
    "load-tests/report.html": htmlReport(data),
    stdout: textSummary(data, {indent: " ", enableColors: true})
  }
}
