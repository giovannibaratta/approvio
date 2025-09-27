// eslint-disable-next-line node/no-unpublished-import
import axios from "axios"
import {ConfigProvider} from "@external/config"

export interface OidcMockUser {
  SubjectId: string
  Username: string
  Password: string
  Claims: Array<{
    Type: string
    Value: string
  }>
}

/**
 * Simulates the OIDC authorization flow by creating a user and performing real login.
 *
 * This function:
 * 1. Creates a test user on the OIDC server via API
 * 2. Extracts login form tokens and cookies
 * 3. Performs actual login with credentials
 * 4. Follows redirects to get authorization code
 *
 * @param redirectLocation - The OIDC authorization URL to start the flow
 * @param testUser - Mock user data to create on OIDC server
 * @param configProvider - Configuration provider for OIDC settings
 * @returns Promise<string> - The authorization code from OIDC provider
 */
export async function simulateOidcAuthorization(
  redirectLocation: string,
  testUser: OidcMockUser,
  configProvider: ConfigProvider
): Promise<string> {
  // Step 1: Create user on OIDC server via API
  const oidcApiUrl = `${configProvider.oidcConfig.issuerUrl}/api/v1/user`
  const createUserResponse = await axios.post(oidcApiUrl, testUser, {
    headers: {"Content-Type": "application/json"}
  })

  if (createUserResponse.status !== 200) throw new Error(`Failed to create OIDC user: ${createUserResponse.status}`)

  // Step 2: Get the login form HTML to extract verification tokens
  const loginFormResponse = await axios.get(redirectLocation)
  const loginFormHtml = loginFormResponse.data

  // Extract cookies from login form response
  const cookies = loginFormResponse.headers["set-cookie"] || []
  const cookieHeader = cookies.map(cookie => cookie.split(";")[0]).join("; ")

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

  const loginResponse = await axios.post("http://localhost:4011/Account/Login", loginFormData.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader,
      Referer: redirectLocation
    },
    maxRedirects: 0,
    validateStatus: status => status === 302
  })

  // Step 5: Handle the authorization redirect
  const location = loginResponse.headers.location
  if (!location) throw new Error("No redirect location found after login")

  if (!location.startsWith("/connect/authorize")) throw new Error(`Unexpected redirect location: ${location}`)

  // Update cookies from login response
  const loginCookies = loginResponse.headers["set-cookie"] || []
  const allCookies = [...cookies, ...loginCookies]
  const updatedCookieHeader = allCookies.map(cookie => cookie.split(";")[0]).join("; ")

  // Follow the authorization callback redirect to get the actual authorization code
  const callbackResponse = await axios.get(`http://localhost:4011${location}`, {
    maxRedirects: 0,
    validateStatus: status => status === 302,
    headers: {
      Cookie: updatedCookieHeader
    },
    withCredentials: true
  })

  const finalLocation = callbackResponse.headers.location
  if (!finalLocation) throw new Error("No final redirect location found after authorization callback")

  // Extract authorization code from the final redirect
  const authCodeMatch = finalLocation.match(/code=([^&]+)/)
  const authCode = authCodeMatch ? authCodeMatch[1] : null

  if (!authCode) throw new Error(`Could not extract authorization code from final redirect: ${finalLocation}`)

  return authCode
}
