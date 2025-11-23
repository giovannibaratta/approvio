/* eslint-disable node/no-unpublished-import */

/**
 * This script can be used to bootstrap a testing environment by creating a test user and an admin user.
 * It will also create a group and a workflow template.
 */

import axios, {AxiosInstance, isAxiosError} from "axios"
import {PrismaClient} from "../../generated/prisma/client"
import * as crypto from "crypto"

// Configuration
const IDP_URL = process.env.IDP_URL || "http://localhost:4010"
const API_URL = process.env.API_URL || "http://localhost:3000"

const ADMIN_USER = {
  email: "admin@localhost.com",
  password: "admin-password",
  displayName: "Admin User"
}

const VOTER_USER = {
  email: "voter@localhost.com",
  password: "voter-password",
  displayName: "Voter User"
}

const prisma = new PrismaClient()

// Helper Types
interface Entity {
  id: string
  name?: string
}

interface OidcMockUser {
  SubjectId: string
  Username: string
  Password: string
  Claims: Array<{
    Type: string
    Value: string
  }>
}

async function simulateOidcAuthorization(redirectLocation: string, testUser: OidcMockUser): Promise<string> {
  // Step 1: Create user on OIDC server via API
  const oidcApiUrl = `${IDP_URL}/api/v1/user`
  try {
    await axios.post(oidcApiUrl, testUser, {
      headers: {"Content-Type": "application/json"}
    })
  } catch (error: unknown) {
    // Ignore if user already exists or other non-critical errors for now
    if (isAxiosError(error)) {
      console.log(`Note: OIDC user creation status: ${error.response?.status}`)
    }
  }

  // Step 2: Get the login form HTML to extract verification tokens
  const loginFormResponse = await axios.get(redirectLocation)
  const loginFormHtml = loginFormResponse.data

  // Extract cookies from login form response
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

  if (!verificationToken || !decodedReturnUrl)
    throw new Error("Could not extract __RequestVerificationToken or Input.ReturnUrl from login form")

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
  if (!location) throw new Error("No redirect location found after login")

  if (!location.startsWith("/connect/authorize")) throw new Error(`Unexpected redirect location: ${location}`)

  // Update cookies from login response
  const loginCookies = loginResponse.headers["set-cookie"] || []
  const allCookies = [...cookies, ...loginCookies]
  const updatedCookieHeader = allCookies.map((cookie: string) => cookie.split(";")[0]).join("; ")

  // Follow the authorization callback redirect to get the actual authorization code
  const callbackResponse = await axios.get(`${IDP_URL}${location}`, {
    maxRedirects: 0,
    validateStatus: (status: number) => status === 302,
    headers: {
      Cookie: updatedCookieHeader
    },
    withCredentials: true
  })

  const finalLocation = callbackResponse.headers.location
  if (!finalLocation) throw new Error("No final redirect location found after authorization callback")

  // Extract authorization code and state from the final redirect
  const url = new URL(finalLocation, "http://localhost")
  const authCode = url.searchParams.get("code")
  const state = url.searchParams.get("state")

  if (!authCode || !state)
    throw new Error(`Could not extract authorization code or state from final redirect: ${finalLocation}`)

  return JSON.stringify({code: authCode, state})
}

async function getAccessToken(name: string, email: string): Promise<string> {
  console.log(`Getting access token for ${email}...`)

  // 1. Initiate login to get IDP redirect URL
  console.log(`Initializing token exchange to ${API_URL}/auth/login`)

  const loginInitResponse = await axios.get(`${API_URL}/auth/login`, {
    maxRedirects: 0,
    validateStatus: (status: number) => status === 302
  })

  const redirectLocation = loginInitResponse.headers.location
  if (!redirectLocation) throw new Error("Failed to get IDP redirect URL from /auth/login")
  // 2. Simulate OIDC flow
  const mockUser: OidcMockUser = {
    SubjectId: email,
    Username: email,
    Password: "admin-password", // Assuming password is consistent for test users
    Claims: [
      {Type: "name", Value: name},
      {Type: "email", Value: email},
      {Type: "email_verified", Value: "true"},
      {Type: "entityType", Value: "user"}
    ]
  }

  const authResult = await simulateOidcAuthorization(redirectLocation, mockUser)
  const {code, state} = JSON.parse(authResult)

  console.log(`Received authorization code: ${code}`)
  console.log(`Received authorization state: ${state}`)

  // 3. Exchange code for token via backend
  const tokenResponse = await axios.post(`${API_URL}/auth/token`, {
    code,
    state
  })

  return tokenResponse.data.token
}

/**
 * Ensures a user exists in the database.
 */
async function ensureUserInDb(email: string, displayName: string, isAdmin: boolean = false) {
  let user = await prisma.user.findUnique({
    where: {email}
  })

  if (!user) {
    console.log(`Creating user ${email} in DB...`)
    user = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email,
        displayName,
        createdAt: new Date(),
        occ: 0,
        roles: []
      }
    })

    if (isAdmin) {
      const orgAdmin = await prisma.organizationAdmin.findUnique({
        where: {email}
      })
      if (!orgAdmin) {
        await prisma.organizationAdmin.create({
          data: {
            id: crypto.randomUUID(),
            email,
            createdAt: new Date()
          }
        })
      }
    }
  } else {
    console.log(`User ${email} already exists in DB. Ensuring valid state...`)
    // Ensure roles are empty array to avoid validation errors
    if (!Array.isArray(user.roles)) {
      await prisma.user.update({
        where: {id: user.id},
        data: {roles: []}
      })
    }
  }
  return user
}

/**
 * Extracts ID from Location header.
 */
function extractIdFromLocation(location: string | undefined): string {
  if (!location) throw new Error("No Location header in response")
  const id = location.split("/").pop()
  if (!id) throw new Error("Could not extract ID from Location header")
  return id
}

/**
 * Generic helper to find an entity by name from a list response.
 */
function findEntityByName(items: Entity[], name: string): Entity | undefined {
  return items.find(item => item.name === name)
}

/**
 * Handles 409 conflict by fetching existing entity.
 */
async function handleConflict(
  client: AxiosInstance,
  endpoint: string,
  name: string,
  entityType: string
): Promise<string> {
  console.log(`${entityType} already exists, fetching ID...`)
  const listResponse = await client.get(endpoint)
  const items = Array.isArray(listResponse.data)
    ? listResponse.data
    : listResponse.data.items || listResponse.data.groups || listResponse.data.spaces || listResponse.data.data

  const entity = findEntityByName(items, name)
  if (entity) {
    console.log(`${entityType} Found: ${entity.id}`)
    return entity.id
  }
  throw new Error(`${entityType} not found after conflict`)
}

/**
 * Creates a group or retrieves it if it already exists.
 */
async function createGroup(client: AxiosInstance, name: string, description: string): Promise<string> {
  console.log(`Creating Group '${name}'...`)
  try {
    const response = await client.post("/groups", {name, description})
    const id = extractIdFromLocation(response.headers.location)
    console.log(`Group Created: ${id}`)
    return id
  } catch (error: unknown) {
    if (isAxiosError(error) && error.response?.status === 409) {
      return handleConflict(client, "/groups", name, "Group")
    }
    if (isAxiosError(error)) {
      console.error(`Group creation failed with status: ${error.response?.status}`)
      console.error("Error details:", JSON.stringify(error.response?.data, null, 2))
    }
    throw error
  }
}

/**
 * Creates a space or retrieves it if it already exists.
 */
async function createSpace(client: AxiosInstance, name: string, description: string): Promise<string> {
  console.log(`Creating Space '${name}'...`)
  try {
    const response = await client.post("/spaces", {name, description})
    const id = extractIdFromLocation(response.headers.location)
    console.log(`Space Created: ${id}`)
    return id
  } catch (error: unknown) {
    if (isAxiosError(error) && error.response?.status === 409) {
      return handleConflict(client, "/spaces", name, "Space")
    }
    if (isAxiosError(error)) {
      console.error("Failed to create space:", error.response?.data || error.message)
    }
    throw error
  }
}

/**
 * Creates a workflow template or retrieves it if it already exists.
 */
async function createWorkflowTemplate(
  client: AxiosInstance,
  name: string,
  description: string,
  spaceId: string,
  groupId: string
): Promise<string> {
  console.log(`Creating Workflow Template '${name}' in space ${spaceId} with group ${groupId}...`)
  try {
    const payload = {
      name,
      description,
      spaceId,
      approvalRule: {
        type: "GROUP_REQUIREMENT",
        groupId,
        minCount: 1
      }
    }
    const response = await client.post("/workflow-templates", payload)
    const id = extractIdFromLocation(response.headers.location)
    console.log(`Workflow Template Created: ${id}`)
    return id
  } catch (error: unknown) {
    if (isAxiosError(error) && error.response?.status === 409) {
      return handleConflict(client, "/workflow-templates", name, "Workflow Template")
    }
    if (isAxiosError(error)) {
      console.error("Failed to create workflow template:", error.response?.data || error.message)
    }
    throw error
  }
}

async function addUserToGroup(client: AxiosInstance, groupId: string, userId: string) {
  console.log(`Adding user ${userId} to group ${groupId}...`)
  try {
    await client.post(`/groups/${groupId}/entities`, {
      entities: [
        {
          entity: {
            entityType: "human",
            entityId: userId
          }
        }
      ]
    })
    console.log("User added to group")
  } catch (error: unknown) {
    if (isAxiosError(error) && error.response?.status === 409) {
      console.log("User already in group")
      return
    }
    if (isAxiosError(error)) {
      console.error("Failed to add user to group:", error.response?.data || error.message)
    }
    throw error
  }
}

async function assignUserRole(client: AxiosInstance, userId: string, roleName: string, templateId: string) {
  console.log(`Assigning role ${roleName} to user ${userId} for template ${templateId}...`)
  try {
    await client.put(`/users/${userId}/roles`, {
      roles: [
        {
          roleName,
          scope: {
            type: "workflow_template",
            workflowTemplateId: templateId
          }
        }
      ]
    })
    console.log("Role assigned")
  } catch (error: unknown) {
    if (isAxiosError(error)) {
      console.error("Failed to assign role:", error.response?.data || error.message)
    }
    throw error
  }
}

async function bootstrap() {
  try {
    console.log("--- Starting Bootstrap ---")

    // 1. Database Setup
    const adminUser = await ensureUserInDb(ADMIN_USER.email, ADMIN_USER.displayName, true)
    const voterUser = await ensureUserInDb(VOTER_USER.email, VOTER_USER.displayName, false)

    console.log(`Admin User ID: ${adminUser.id}`)
    console.log(`Voter User ID: ${voterUser.id}`)

    // 2. Authentication
    console.log("Authenticating with IDP...")
    const adminAccessToken = await getAccessToken(ADMIN_USER.displayName, ADMIN_USER.email)
    const voterAccessToken = await getAccessToken(VOTER_USER.displayName, VOTER_USER.email)
    console.log("Authentication successful.")

    const apiClient = axios.create({
      baseURL: API_URL,
      headers: {
        Authorization: `Bearer ${adminAccessToken}`
      }
    })

    // 3. Entity Creation
    const groupId = await createGroup(apiClient, "bootstrap-test-group", "Group created by bootstrap script")
    const spaceId = await createSpace(apiClient, "bootstrap-test-space", "Space created by bootstrap script")
    const templateId = await createWorkflowTemplate(
      apiClient,
      "Bootstrap Workflow Template",
      "Template created by bootstrap script",
      spaceId,
      groupId
    )

    // 4. Permissions
    await addUserToGroup(apiClient, groupId, voterUser.id)
    await assignUserRole(apiClient, voterUser.id, "WorkflowTemplateVoter", templateId)

    // 5. Output
    console.log("\n--- Bootstrap Complete ---")
    console.log(
      JSON.stringify(
        {
          adminUserId: adminUser.id,
          adminAccessToken,
          voterUserId: voterUser.id,
          voterAccessToken,
          groupId,
          spaceId,
          workflowTemplateId: templateId
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error("\n--- Bootstrap Failed ---")
    if (error instanceof Error) console.error(error.stack)

    if (isAxiosError(error))
      console.error(
        "Failed to query endpoint " + error.config?.url + " with status code: " + error.response?.status,
        error.response?.data
      )
    else console.error(error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

// Main execution
async function main() {
  await bootstrap()
}

main()
