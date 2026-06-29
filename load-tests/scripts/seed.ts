/**
 * Seeding script for load testing.
 * Initializes the database with the required topology (spaces, groups, templates, users)
 * and writes their identifiers and authentication tokens to `seed-data.json` for
 * consumption by the k6 load testing scripts.
 */
import {v7 as uuidv7} from "uuid"
import axios, {isAxiosError} from "axios"
import * as fs from "fs"
import * as path from "path"
import {ApprovalRule, QuotaType} from "@approvio/api"

// Configuration
const IDP_URL = process.env.IDP_URL || "http://localhost:4010"
const API_URL = process.env.API_URL || "http://localhost:3000"

// Load test configuration parameterized via environment variables with default fallback values.
const NUM_SPACES = parseInt(process.env.NUM_SPACES || "5", 10)
const NUM_GROUPS = parseInt(process.env.NUM_GROUPS || "10", 10)
const NUM_TEMPLATES_PER_SPACE = parseInt(process.env.NUM_TEMPLATES_PER_SPACE || "2", 10)
const NUM_USERS = parseInt(process.env.NUM_USERS || "20", 10)

interface OidcMockUser {
  SubjectId: string
  Username: string
  Password: string
  Claims: Array<{
    Type: string
    Value: string
  }>
}

// This mimics the authorization flow of scripts/testing/bootstrap-env.ts.
// Note: This relies on the mock OIDC server (IDP) container running in the docker-compose environment.
async function simulateOidcAuthorization(redirectLocation: string, testUser: OidcMockUser): Promise<string> {
  // Step 1: Create user on OIDC server via API
  const oidcApiUrl = `${IDP_URL}/api/v1/user`
  try {
    await axios.post(oidcApiUrl, testUser, {
      headers: {"Content-Type": "application/json"}
    })
  } catch (error: unknown) {
    if (isAxiosError(error) && error.response?.status !== 409) {
      console.log(`Note: OIDC user creation status: ${error.response?.status}`)
    }
  }

  // Step 2: Get the login form HTML to extract verification tokens
  const loginFormResponse = await axios.get(redirectLocation)
  const loginFormHtml = loginFormResponse.data

  const cookies = loginFormResponse.headers["set-cookie"] || []
  const cookieHeader = cookies.map((cookie: string) => cookie.split(";")[0]).join("; ")

  // Step 3: Extract verification token and ReturnUrl from the HTML form
  const verificationTokenMatch = loginFormHtml.match(
    /name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]*)"/
  )
  const returnUrlMatch = loginFormHtml.match(/name="Input.ReturnUrl"\s+value="([^"]*)"/)

  const verificationToken = verificationTokenMatch?.[1]
  const returnUrl = returnUrlMatch?.[1]

  // HTML decode the ReturnUrl since it was extracted from HTML content
  const decodedReturnUrl = returnUrl
    ?.replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')

  if (!verificationToken || !decodedReturnUrl) {
    throw new Error("Could not extract __RequestVerificationToken or Input.ReturnUrl")
  }

  // Step 4: Submit login form with real credentials
  const loginFormData = new URLSearchParams({
    "Input.Username": testUser.Username,
    "Input.Password": testUser.Password,
    "Input.ReturnUrl": decodedReturnUrl,
    "Input.RememberLogin": "false",
    "Input.Button": "login",
    __RequestVerificationToken: verificationToken
  })

  const loginResponse = await axios.post(`${IDP_URL}/Account/Login`, loginFormData.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader,
      Referer: redirectLocation
    },
    maxRedirects: 0,
    validateStatus: (status: number) => status === 302
  })

  // Step 5: Handle the authorization redirect
  const location = loginResponse.headers.location
  if (!location || !location.startsWith("/connect/authorize")) {
    throw new Error(`Unexpected redirect location: ${location}`)
  }

  const loginCookies = loginResponse.headers["set-cookie"] || []
  const allCookies = [...cookies, ...loginCookies]
  const updatedCookieHeader = allCookies.map((cookie: string) => cookie.split(";")[0]).join("; ")

  // Follow the authorization callback redirect to get the actual authorization code
  const callbackResponse = await axios.get(`${IDP_URL}${location}`, {
    maxRedirects: 0,
    validateStatus: (status: number) => status === 302,
    headers: {Cookie: updatedCookieHeader},
    withCredentials: true
  })

  const finalLocation = callbackResponse.headers.location
  if (!finalLocation) throw new Error("No final redirect location found")

  // Extract authorization code and state from the final redirect
  const url = new URL(finalLocation, "http://localhost")
  const authCode = url.searchParams.get("code")
  const state = url.searchParams.get("state")

  if (!authCode || !state) throw new Error("Could not extract code/state")

  return JSON.stringify({code: authCode, state})
}

// 1. Initiate login to get IDP redirect URL
// 2. Simulate OIDC flow
// 3. Exchange code for token via backend
async function getAccessToken(email: string, displayName: string): Promise<string> {
  const loginInitResponse = await axios.get(`${API_URL}/auth/web/login`, {
    maxRedirects: 0,
    validateStatus: (status: number) => status === 302
  })

  const redirectLocation = loginInitResponse.headers.location
  if (!redirectLocation) throw new Error("Failed to get IDP redirect")

  const mockUser: OidcMockUser = {
    SubjectId: email,
    Username: email,
    Password: "password123",
    Claims: [
      {Type: "name", Value: displayName},
      {Type: "email", Value: email},
      {Type: "email_verified", Value: "true"},
      {Type: "entityType", Value: "user"}
    ]
  }

  const authResult = await simulateOidcAuthorization(redirectLocation, mockUser)
  const {code, state} = JSON.parse(authResult)

  const tokenResponse = await axios.post(`${API_URL}/auth/cli/token`, {code, state})
  return tokenResponse.data.accessToken
}

// All seeding is done via the HTTP API, which provides a stable and decoupled interface.
async function seed() {
  console.log("Seeding Load Test Topology...")

  // 1. Retrieve the admin access token (auto-registers user as admin via OIDC if system is empty)
  const adminEmail = "loadadmin@localhost.com"
  const adminToken = await getAccessToken(adminEmail, "Load Admin")

  const apiClient = axios.create({
    baseURL: API_URL,
    headers: {Authorization: `Bearer ${adminToken}`}
  })

  // Helper function to extract ID from location header
  const extractId = (location: string | undefined) => {
    if (!location) throw new Error("No location header")
    return location.split("/").pop() as string
  }

  // 2. Setup high quotas to avoid hitting limits during load tests
  const TARGET_ORG_ID = "00000000-0000-0000-0000-000000000000"
  const quotaTypes: QuotaType[] = [
    "MAX_SPACES",
    "MAX_GROUPS",
    "MAX_CONCURRENT_WORKFLOWS",
    "MAX_WORKFLOW_TEMPLATES_PER_SPACE",
    "MAX_ENTITIES_PER_GROUP",
    "MAX_ROLES_PER_USER",
    "MAX_VOTES_PER_WORKFLOW"
  ]

  for (const quotaType of quotaTypes) {
    try {
      const res = await apiClient.get("/quotas", {
        params: {
          scope: "Org",
          quotaType: quotaType
        }
      })
      const existingQuota = res.data?.data?.[0]
      if (existingQuota) {
        await apiClient.patch(`/quotas/${existingQuota.id}`, {
          limit: 1000000
        })
      } else {
        await apiClient.post("/quotas", {
          scope: "Org",
          targetId: TARGET_ORG_ID,
          quotaType: quotaType,
          limit: 1000000
        })
      }
    } catch (e: any) {
      console.warn(`Could not setup quota for ${quotaType}:`, e.message, e.response?.data)
    }
  }

  // 3. Create Users
  const users: {id: string; email: string; token: string}[] = []
  for (let i = 0; i < NUM_USERS; i++) {
    const email = `loaduser${i}@localhost.com`
    const displayName = `Load User ${i}`

    let userId: string
    try {
      const res = await apiClient.post("/users", {
        email,
        displayName,
        orgRole: "member"
      })
      userId = extractId(res.headers.location)
    } catch (err: any) {
      if (err.response?.status === 409) {
        const getRes = await apiClient.get(`/users/${email}`)
        userId = getRes.data.id
      } else {
        console.error(`Failed to create user ${email}:`, err.message, err.response?.data)
        throw err
      }
    }

    const token = await getAccessToken(email, displayName)
    users.push({id: userId, email, token})
    console.log(`Seeded user ${i + 1}/${NUM_USERS}`)
  }

  // 4. Create Groups
  const groupMembersMap = new Map<string, typeof users>()
  const groupIds = []
  for (let i = 0; i < NUM_GROUPS; i++) {
    const name = `load-group-${i}-${uuidv7().slice(0, 8)}-${Math.random().toString(36).substring(2, 7)}`
    try {
      const res = await apiClient.post("/groups", {name, description: "Load test group"})
      const groupId = extractId(res.headers.location)
      groupIds.push(groupId)

      // Add random users to group
      const entities = []
      for (let j = 0; j < 5; j++) {
        const randomUser = users[Math.floor(Math.random() * users.length)]
        if (randomUser) {
          entities.push({entity: {entityType: "human", entityId: randomUser.id}})
        }
      }
      // Deduplicate entities to avoid 409s on group add
      const uniqueEntities = Array.from(new Map(entities.map(e => [e.entity.entityId, e])).values())

      await apiClient.post(`/groups/${groupId}/entities`, {entities: uniqueEntities})

      const groupMembers = uniqueEntities
        .map(ue => users.find(u => u.id === ue.entity.entityId))
        .filter(Boolean) as typeof users
      console.log(
        `DEBUG GROUP ${i}: users=${users.length}, entities=${entities.length}, uniqueEntities=${uniqueEntities.length}, groupMembers=${groupMembers.length}`
      )
      groupMembersMap.set(groupId, groupMembers)
    } catch (e: any) {
      console.error(`Failed to create group ${i}:`, e.message, e.response?.data)
    }
  }
  console.log(`Seeded ${groupIds.length} groups`)

  // 5. Create Spaces and Templates
  const spaces = []
  const templates = []

  for (let i = 0; i < NUM_SPACES; i++) {
    const spaceName = `load-space-${i}-${uuidv7().slice(0, 8)}-${Math.random().toString(36).substring(2, 7)}`
    try {
      const res = await apiClient.post("/spaces", {name: spaceName, description: "Load test space"})
      const spaceId = extractId(res.headers.location)
      spaces.push(spaceId)

      for (let j = 0; j < NUM_TEMPLATES_PER_SPACE; j++) {
        const templateName = `load-template-${i}-${j}-${uuidv7().slice(0, 8)}-${Math.random().toString(36).substring(2, 7)}`
        const randomGroupId = groupIds[Math.floor(Math.random() * groupIds.length)]
        if (!randomGroupId) continue

        // Determine approval rule configuration (50% simple, 25% AND, 25% OR)
        let approvalRule: ApprovalRule | null = null
        const ruleTypeRand = Math.random()
        const targetGroups: string[] = []

        if (ruleTypeRand < 0.5) {
          targetGroups.push(randomGroupId)
          approvalRule = {
            type: "GROUP_REQUIREMENT" as const,
            groupId: randomGroupId,
            minCount: 1
          }
        } else {
          let secondGroupId = groupIds[Math.floor(Math.random() * groupIds.length)]
          while (secondGroupId === randomGroupId && groupIds.length > 1) {
            secondGroupId = groupIds[Math.floor(Math.random() * groupIds.length)]
          }
          targetGroups.push(randomGroupId)
          if (secondGroupId) targetGroups.push(secondGroupId)

          const rules = targetGroups.map(gId => ({
            type: "GROUP_REQUIREMENT" as const,
            groupId: gId,
            minCount: 1
          }))

          approvalRule = {
            type: ruleTypeRand < 0.75 ? ("AND" as const) : ("OR" as const),
            rules: rules
          }
        }

        const templateRes = await apiClient.post("/workflow-templates", {
          name: templateName,
          description: "Load test template",
          spaceId,
          approvalRule
        })
        const templateId = extractId(templateRes.headers.location)

        const templateVoters = []
        for (const targetGroupId of targetGroups) {
          const groupMembers = groupMembersMap.get(targetGroupId) || []
          for (const member of groupMembers) {
            try {
              // Retrieve user from API to get the current OCC version
              const getRes = await apiClient.get(`/users/${member.id}`)
              const currentVersion = getRes.data.concurrencyControl.version

              await apiClient.put(`/users/${member.id}/roles`, {
                concurrencyControl: {
                  version: currentVersion
                },
                roles: [
                  {
                    roleName: "WorkflowTemplateVoter",
                    scope: {
                      type: "workflow_template",
                      templateName: templateName
                    }
                  }
                ]
              })
            } catch (err: any) {
              console.error(`Failed to assign role to user ${member.id}:`, err.message, err.response?.data)
            }

            templateVoters.push({token: member.token, groupId: targetGroupId})
          }
        }

        templates.push({
          id: templateId,
          name: templateName,
          voters: templateVoters
        })
      }
    } catch (e: any) {
      console.error(`Failed to create space/template ${i}:`, e.message, e.response?.data)
    }
  }
  console.log(`Seeded ${spaces.length} spaces and ${templates.length} templates`)

  const seedData = {
    users: users.map(u => ({id: u.id, token: u.token})),
    adminToken,
    groups: groupIds,
    spaces,
    templates
  }

  const outputPath = path.join(__dirname, "..", "seed-data.json")
  fs.writeFileSync(outputPath, JSON.stringify(seedData, null, 2))
  console.log(`Seed data written to ${outputPath}`)
}

seed().catch(e => {
  console.error("Seed failed", e)
  process.exit(1)
})
