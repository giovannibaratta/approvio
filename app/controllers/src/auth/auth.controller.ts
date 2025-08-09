import {Controller, Get, Post, Res, Logger, UnauthorizedException, Query, Body} from "@nestjs/common"
import {Response} from "express"
import {AuthService, PkceService} from "@services"
import {isLeft} from "fp-ts/lib/Either"
import {PublicRoute} from "../../../main/src/auth/jwt.authguard"
import {GetAuthenticatedUser} from "../../../main/src/auth/get-authenticated-user.decorator"
import {User} from "@domain"

/**
 * ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 * │                         OIDC Authentication HTTP Endpoints Flow                         │
 * │                              (Load Balancer Compatible)                                 │
 * ├─────────────────────────────────────────────────────────────────────────────────────────┤
 * │                                                                                         │
 * │  Frontend      Load Balancer      Backend A/B       OIDC Provider      Database         │
 * │     │               │                 │                  │                │             │
 * │ 1. GET /auth/login                                                                      │
 * │     │ ──────────────┼────────────────►│ Generate PKCE    │                │             │
 * │     │               │                 │ challenge        │                │             │
 * │     │               │                 │ + Auth URL       │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │ Store PKCE ─────────────────────►│ Session      │
 * │     │               │                 │ {state, codeV}   │                │ Storage     │
 * │     │               │                 │                  │                │             │
 * │     │ 302 Redirect  │ ◄───────────────│ Redirect to      │                │             │
 * │     │ to OIDC       │                 │ OIDC Provider    │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │ 2. User Authentication                                                                  │
 * │     │ ─────────────────────────────────────────────────►│ User login     │              │
 * │     │               │                 │                  │ & consent      │             │
 * │     │               │                 │                  │                │             │
 * │ 3. GET /auth/callback?code=abc&state=xyz                                                │
 * │     │ ◄─────────────────────────────────────────────────│ Authorization  │              │
 * │     │               │                 │                  │ code callback  │             │
 * │     │               │                 │                  │                │             │
 * │     │ ──────────────┼────────────────►│ Any server can   │                │             │
 * │     │               │                 │ handle callback  │                │             │
 * │     │               │                 │                  │                │             │
 * │     │ 302 Redirect  │ ◄───────────────│ Redirect to      │                │             │
 * │     │ to success    │                 │ /success?code=.. │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │ 4. POST /auth/token {code, state}                                                       │
 * │     │ ──────────────┼────────────────►│ Retrieve PKCE ◄─────────────────│ Lookup by     │
 * │     │               │                 │ data from DB     │                │ state       │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │ Exchange code ──────────────────►│ Token        │
 * │     │               │                 │ + codeVerifier   │                │ Exchange    │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │ Get user info ──────────────────►│ User         │
 * │     │               │                 │ (basic claims)   │                │ Claims      │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │ Lookup user ────────────────────►│ Enhanced     │
 * │     │               │                 │ orgRole & roles  │                │ User Data   │
 * │     │               │                 │                  │                │             │
 * │     │ Enhanced JWT  │ ◄───────────────│ Generate JWT     │                │             │
 * │     │ w/ orgRole,   │                 │ with enhanced    │                │             │
 * │     │ roles, etc.   │                 │ payload          │                │             │
 * │                                                                                         │
 * │ Enhanced JWT Payload:                                                                   │
 * │ {                                                                                       │
 * │   "sub": "user-uuid",           // OIDC standard                                        │
 * │   "email": "user@example.com",  // OIDC standard                                        │
 * │   "name": "John Doe",           // OIDC standard                                        │
 * │   "orgRole": "admin",           // Enhanced: admin/member                               │
 * │   "roles": [                    // Enhanced: specific permissions                       │
 * │     {"name": "approver", "scope": {"type": "space", "spaceId": "space-123"}},           │
 * │     {"name": "viewer", "scope": {"type": "group", "groupId": "group-456"}}              │
 * │   ]                                                                                     │
 * │ }                                                                                       │
 * │                                                                                         │
 * │ Load Balancer Benefits:                                                                 │
 * │ • PKCE data stored in shared database - any server can access                           │
 * │ • Stateless authentication - no server affinity required                                │
 * │ • Enhanced JWT includes organizational context not available from OIDC provider         │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 */
@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name)

  constructor(
    private readonly authService: AuthService,
    private readonly pkceService: PkceService
  ) {}

  @PublicRoute()
  @Get("login")
  async login(@Res() res: Response): Promise<void> {
    const pkceResult = await this.pkceService.generatePkceChallenge()()

    if (isLeft(pkceResult)) {
      this.logger.error("Failed to generate PKCE challenge", pkceResult.left)
      res.redirect("/auth/error")
      return
    }

    const pkceChallenge = pkceResult.right

    // Store PKCE data for later verification
    const storeResult = await this.pkceService.storePkceData(pkceChallenge.state, {
      codeVerifier: pkceChallenge.codeVerifier,
      redirectUri: this.authService.getRedirectUri(),
      oidcState: pkceChallenge.state
    })()

    if (isLeft(storeResult)) {
      this.logger.error("Failed to store PKCE data", storeResult.left)
      res.redirect("/auth/error")
      return
    }

    // Generate OIDC authorization URL
    const authUrlResult = await this.authService.generateAuthorizationUrl(pkceChallenge)()

    if (isLeft(authUrlResult)) {
      this.logger.error("Failed to generate authorization URL", authUrlResult.left)
      res.redirect("/auth/error")
      return
    }

    Logger.debug(`Redirecting to OIDC provider: ${authUrlResult.right}`)
    res.redirect(authUrlResult.right)
  }

  @PublicRoute()
  @Get("callback")
  async callback(@Query("code") code: string, @Query("state") state: string, @Res() res: Response): Promise<void> {
    if (!code || !state) {
      this.logger.error("Missing code or state in OIDC callback")
      res.redirect("/auth/error")
      return
    }

    // Redirect to success page with code and state for frontend to exchange for JWT
    res.redirect(`/auth/success?code=${code}&state=${state}`)
  }

  @PublicRoute()
  @Post("token")
  async generateToken(@Body() body: {code: string; state: string}): Promise<{token: string}> {
    if (!body) {
      throw new UnauthorizedException("Missing required parameters")
    }

    const {code, state} = body

    if (!code || !state) {
      throw new UnauthorizedException("Missing required parameters")
    }

    // Retrieve PKCE data (including codeVerifier) using state and consume the session
    const pkceResult = await this.pkceService.retrieveAndConsumePkceData(state)()

    if (isLeft(pkceResult)) {
      this.logger.error("PKCE data retrieval failed", pkceResult.left)
      throw new UnauthorizedException("Invalid authentication session")
    }

    const tokenResult = await this.authService.authenticateWithOidc(code, pkceResult.right)()

    if (isLeft(tokenResult)) {
      this.logger.error("Token generation failed", tokenResult.left)
      throw new UnauthorizedException("Failed to generate token")
    }

    return {token: tokenResult.right}
  }

  @PublicRoute()
  @Get("success")
  async success(): Promise<{message: string}> {
    return {message: "Authentication successful. Use the code and state to generate a JWT token."}
  }

  @PublicRoute()
  @Get("error")
  async error(): Promise<{message: string}> {
    return {message: "Authentication failed. Please try again."}
  }

  @Get("info")
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getUserInfo(@GetAuthenticatedUser() user: User): Promise<{entityType: string}> {
    return {entityType: "user"}
  }
}
